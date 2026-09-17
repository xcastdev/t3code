import {
  McpCatalogSessionId,
  McpServerId,
  type ProviderInstanceId,
  type ResolvedMcpCatalogEntry,
  type ThreadId,
} from "@t3tools/contracts";
import {
  Client,
  StreamableHTTPClientTransport,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
} from "@modelcontextprotocol/client";
import {
  InMemoryServerEventBus,
  Server,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "effect/unstable/http";

import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";
import type * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

/** The stable name exposed to a provider for one upstream MCP item. */
export const namespaceName = (logicalId: McpServerId, upstreamName: string): string =>
  `mcp_${String(logicalId).replaceAll("-", "")}__${upstreamName}`;

/** The stable URI exposed to a provider for one upstream resource. */
export const namespaceResourceUri = (logicalId: McpServerId, upstreamUri: string): string =>
  `t3-mcp://${String(logicalId)}/${Buffer.from(upstreamUri).toString("base64url")}`;

/**
 * Resource templates need to remain templates after namespacing: encoding the
 * complete template as base64 would prevent an MCP client from substituting
 * `{variables}`. Static characters are URI encoded while braces are retained.
 */
export const namespaceResourceTemplate = (
  logicalId: McpServerId,
  upstreamTemplate: string,
): string =>
  // Keep a marker so an all-alphanumeric URI template cannot be mistaken for
  // the base64url form used by concrete resource URIs when it is read back.
  `t3-mcp://${String(logicalId)}/template/${encodeURIComponent(upstreamTemplate)
    .replaceAll("%7B", "{")
    .replaceAll("%7D", "}")}`;

export const denamespaceResourceUri = (
  logicalId: McpServerId,
  exposedUri: string,
): string | undefined => {
  const prefix = `t3-mcp://${String(logicalId)}/`;
  if (!exposedUri.startsWith(prefix)) return undefined;
  const encoded = exposedUri.slice(prefix.length);
  try {
    if (encoded.startsWith("template/"))
      return decodeURIComponent(encoded.slice("template/".length));
    // Concrete resources use the compact, unambiguous base64 form. Templates
    // use encoded static URI characters and retain variable braces.
    if (/^[A-Za-z0-9_-]+$/.test(encoded)) {
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      if (decoded.length > 0) return decoded;
    }
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
};

/** Rewrite resource-bearing content returned by an upstream server. */
export const namespaceContentUris = (logicalId: McpServerId, value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => namespaceContentUris(logicalId, item));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  const rewritten = Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, namespaceContentUris(logicalId, item)]),
  );
  if (
    typeof object.uri === "string" &&
    (object.type === "resource" || object.type === "resource_link" || "mimeType" in object)
  ) {
    rewritten.uri = namespaceResourceUri(logicalId, object.uri);
  }
  return rewritten;
};

const namespaceContentResult = <A>(logicalId: McpServerId, value: A): A =>
  namespaceContentUris(logicalId, value) as A;

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
  /** Stable endpoint consumed by provider-native MCP clients. */
  readonly endpoint: string;
}

interface GatewayGeneration {
  readonly token: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly proxyProviderSessionId: string;
  readonly revision: number;
  readonly entries: ReadonlyArray<McpCatalogGatewayEntry>;
  readonly endpoints: ReadonlyArray<ProjectMcpProxyRegistry.ProjectMcpProxyEndpoint>;
  clients: Map<string, Promise<Client>>;
  resources: Map<string, { readonly entry: McpCatalogGatewayEntry; readonly uri: string }>;
  readonly resourceSubscriptions: Map<string, Set<object>>;
  entryCapabilities: Map<string, GatewayEntryCapabilities>;
  capabilities: GatewayCapabilities;
  activeRequests: number;
  retiring: boolean;
  idle?: { readonly resolve: () => void };
  closePromise?: Promise<void>;
}

interface GatewayEntryCapabilities {
  readonly tools?: { readonly listChanged?: boolean | undefined } | undefined;
  readonly resources?:
    | { readonly listChanged?: boolean | undefined; readonly subscribe?: boolean | undefined }
    | undefined;
  readonly prompts?: { readonly listChanged?: boolean | undefined } | undefined;
}

type GatewayCapabilities = GatewayEntryCapabilities;

// The gateway is one stable MCP server for the lifetime of a provider
// session. Its list methods must remain callable even while the catalog is
// empty or being replaced; upstream capability discovery only controls which
// entries can contribute data, not the gateway protocol surface.
const GATEWAY_CAPABILITIES: GatewayCapabilities = {
  tools: { listChanged: true },
  resources: { listChanged: true, subscribe: true },
  prompts: { listChanged: true },
};

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
  readonly resolveProviderSession: (
    providerSessionId: string,
    catalogSessionId: McpCatalogSessionId,
  ) => Effect.Effect<McpCatalogGatewaySession | undefined>;
  readonly handle: (
    providerSessionId: string,
    catalogSessionId: McpCatalogSessionId,
    request: Request,
  ) => Effect.Effect<Response>;
  readonly revokeRuntime: (providerSessionId: string) => Effect.Effect<void>;
  readonly disposeCatalogSession: (catalogSessionId: McpCatalogSessionId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpCatalogGateway extends Context.Service<McpCatalogGateway, McpCatalogGatewayShape>()(
  "t3/mcp/McpCatalogGateway",
) {}

interface GatewayRuntime extends Omit<
  McpCatalogGatewaySession,
  "providerSessionId" | "providerInstanceId" | "revision" | "entries" | "endpoints"
> {
  providerSessionId: string;
  providerInstanceId: ProviderInstanceId;
  readonly proxyProviderSessionId: string;
  readonly bus: InMemoryServerEventBus;
  readonly handler: McpHttpHandler;
  revision: number;
  entries: ReadonlyArray<McpCatalogGatewayEntry>;
  endpoints: ReadonlyArray<ProjectMcpProxyRegistry.ProjectMcpProxyEndpoint>;
  clients: Map<string, Promise<Client>>;
  resources: Map<string, { readonly entry: McpCatalogGatewayEntry; readonly uri: string }>;
  generation: GatewayGeneration;
  /** Generations retained while a provider replacement transaction settles. */
  retiringGenerations: Map<string, GatewayGeneration>;
  resolveSecret?: RegisterCatalogSessionInput["resolveSecret"];
  oauthStateLeases?: RegisterCatalogSessionInput["oauthStateLeases"];
}

const baseFromHttpServer = (httpServer: HttpServer.HttpServer["Service"]): string => {
  if (httpServer.address._tag !== "TcpAddress") return "http://127.0.0.1";
  const hostname =
    httpServer.address.hostname === "0.0.0.0" || httpServer.address.hostname === "::"
      ? "127.0.0.1"
      : httpServer.address.hostname;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${host}:${httpServer.address.port}`;
};

const listChangedMethods = [
  "notifications/tools/list_changed",
  "notifications/resources/list_changed",
  "notifications/prompts/list_changed",
] as const;

const publishListChanges = (bus: InMemoryServerEventBus): void => {
  for (const method of listChangedMethods) {
    void bus.publish(
      method === "notifications/tools/list_changed"
        ? { kind: "tools_list_changed" }
        : method === "notifications/resources/list_changed"
          ? { kind: "resources_list_changed" }
          : { kind: "prompts_list_changed" },
    );
  }
};

const findNamespacedTarget = (generation: GatewayGeneration, name: string) => {
  // `exposedName` includes the upstream item name. Route using only the
  // logical-server prefix so `mcp_weather__forecast` is forwarded as
  // `forecast` (and never accidentally as a suffix of another item).
  const entry = generation.entries.find((candidate) => {
    const prefix = `mcp_${String(candidate.logicalServerId).replaceAll("-", "")}__`;
    return name.startsWith(prefix) && name.slice(prefix.length).length > 0;
  });
  return entry === undefined
    ? undefined
    : {
        entry,
        name: name.slice(`mcp_${String(entry.logicalServerId).replaceAll("-", "")}__`.length),
      };
};

const findResourceTarget = (generation: GatewayGeneration, uri: string) => {
  const entry = generation.entries.find((candidate) => uri.startsWith(candidate.resourceUriPrefix));
  if (entry === undefined) return undefined;
  const upstream = denamespaceResourceUri(entry.logicalServerId, uri);
  return upstream === undefined ? undefined : { entry, uri: upstream };
};

const makeClient = (
  runtime: GatewayRuntime,
  entry: McpCatalogGatewayEntry,
  endpoint: ProjectMcpProxyRegistry.ProjectMcpProxyEndpoint,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
  generation: GatewayGeneration = runtime.generation,
): Promise<Client> => {
  const fetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    return Effect.runPromise(
      proxy.handle(generation.proxyProviderSessionId, endpoint.endpointHandle, request),
    );
  };
  const transport = new StreamableHTTPClientTransport(
    new URL("http://t3-mcp-catalog.invalid/mcp"),
    {
      fetch,
    },
  );
  const client = new Client(
    { name: "t3-catalog-gateway", version: "1" },
    {
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
        elicitation: { form: {}, url: {} },
      },
      versionNegotiation: { mode: "auto" },
    },
  );
  for (const method of listChangedMethods) {
    client.setNotificationHandler(method, () => {
      runtime.bus.publish(
        method === "notifications/tools/list_changed"
          ? { kind: "tools_list_changed" }
          : method === "notifications/resources/list_changed"
            ? { kind: "resources_list_changed" }
            : { kind: "prompts_list_changed" },
      );
    });
  }
  client.setNotificationHandler("notifications/resources/updated", (notification) => {
    const uri =
      typeof notification.params?.uri === "string"
        ? namespaceItemResourceUri(entry, notification.params.uri)
        : undefined;
    if (uri !== undefined) runtime.bus.publish({ kind: "resource_updated", uri });
  });
  return client.connect(transport).then(() => client);
};

const clientFor = (
  runtime: GatewayRuntime,
  entry: McpCatalogGatewayEntry,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
  generation: GatewayGeneration = runtime.generation,
): Promise<Client> => {
  const existing = generation.clients.get(String(entry.logicalServerId));
  if (existing) return existing;
  const endpoint = generation.endpoints.find((candidate) => candidate.id === entry.logicalServerId);
  if (!endpoint) return Promise.reject(new Error("MCP catalog endpoint is unavailable."));
  const opening = makeClient(runtime, entry, endpoint, proxy, generation);
  generation.clients.set(String(entry.logicalServerId), opening);
  return opening;
};

const collectPages = async <A>(
  request: (params?: { readonly cursor?: string }) => Promise<A>,
  field: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const values: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = (await request(
      cursor === undefined ? undefined : { cursor },
    )) as unknown as Record<string, unknown>;
    const items = page[field];
    if (Array.isArray(items))
      values.push(
        ...items.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        ),
      );
    cursor =
      typeof page.nextCursor === "string" && page.nextCursor.length ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return values;
};

const listTools = async (
  runtime: GatewayRuntime,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
  generation: GatewayGeneration = runtime.generation,
): Promise<ListToolsResult> => {
  const tools: Array<Record<string, unknown>> = [];
  for (const entry of generation.entries) {
    if (generation.entryCapabilities.get(String(entry.logicalServerId))?.tools === undefined)
      continue;
    const client = await clientFor(runtime, entry, proxy, generation);
    const upstream = await collectPages((params) => client.listTools(params), "tools");
    for (const tool of upstream) {
      tools.push({ ...tool, name: namespaceItemName(entry, String(tool.name)) });
    }
  }
  return { tools, ttlMs: 0, cacheScope: "private" as const } as unknown as ListToolsResult;
};

const listResources = async (
  runtime: GatewayRuntime,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
  generation: GatewayGeneration = runtime.generation,
): Promise<ListResourcesResult> => {
  const resources: Array<Record<string, unknown>> = [];
  for (const entry of generation.entries) {
    if (generation.entryCapabilities.get(String(entry.logicalServerId))?.resources === undefined)
      continue;
    const client = await clientFor(runtime, entry, proxy, generation);
    const upstream = await collectPages((params) => client.listResources(params), "resources");
    for (const resource of upstream) {
      const upstreamUri = String(resource.uri);
      const exposedUri = namespaceItemResourceUri(entry, upstreamUri);
      generation.resources.set(exposedUri, { entry, uri: upstreamUri });
      resources.push({
        ...resource,
        uri: exposedUri,
        ...(typeof resource.name === "string"
          ? { name: namespaceItemName(entry, resource.name) }
          : {}),
      });
    }
  }
  return { resources, ttlMs: 0, cacheScope: "private" as const } as unknown as ListResourcesResult;
};

const listResourceTemplates = async (
  runtime: GatewayRuntime,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
  generation: GatewayGeneration = runtime.generation,
): Promise<ListResourceTemplatesResult> => {
  const resourceTemplates: Array<Record<string, unknown>> = [];
  for (const entry of generation.entries) {
    if (generation.entryCapabilities.get(String(entry.logicalServerId))?.resources === undefined)
      continue;
    const client = await clientFor(runtime, entry, proxy, generation);
    const upstream = await collectPages(
      (params) => client.listResourceTemplates(params),
      "resourceTemplates",
    );
    for (const template of upstream) {
      resourceTemplates.push({
        ...template,
        uriTemplate: namespaceResourceTemplate(entry.logicalServerId, String(template.uriTemplate)),
        ...(typeof template.name === "string"
          ? { name: namespaceItemName(entry, template.name) }
          : {}),
      });
    }
  }
  return {
    resourceTemplates,
    ttlMs: 0,
    cacheScope: "private" as const,
  } as unknown as ListResourceTemplatesResult;
};

const listPrompts = async (
  runtime: GatewayRuntime,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
  generation: GatewayGeneration = runtime.generation,
): Promise<ListPromptsResult> => {
  const prompts: Array<Record<string, unknown>> = [];
  for (const entry of generation.entries) {
    if (generation.entryCapabilities.get(String(entry.logicalServerId))?.prompts === undefined)
      continue;
    const client = await clientFor(runtime, entry, proxy, generation);
    const upstream = await collectPages((params) => client.listPrompts(params), "prompts");
    for (const prompt of upstream) {
      prompts.push({ ...prompt, name: namespaceItemName(entry, String(prompt.name)) });
    }
  }
  return { prompts, ttlMs: 0, cacheScope: "private" as const } as unknown as ListPromptsResult;
};

const makeServer = (
  runtime: GatewayRuntime,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
): Server => {
  const generation = runtime.generation;
  const server = new Server(
    { name: "T3 MCP catalog", version: "1" },
    {
      capabilities: GATEWAY_CAPABILITIES,
    },
  );
  const releaseSubscriptionOwner = async (uri: string, owner: object): Promise<void> => {
    // A downstream stream can outlive a catalog generation swap. Ownership is
    // copied into the replacement generation, so release it in both maps and
    // unsubscribe only from the generation that is currently serving calls.
    const generations = new Set([generation, runtime.generation]);
    for (const candidate of generations) {
      const owners = candidate.resourceSubscriptions.get(uri);
      if (!owners?.delete(owner)) continue;
      if (owners.size > 0) continue;
      candidate.resourceSubscriptions.delete(uri);
      if (candidate !== runtime.generation) continue;
      const target = candidate.resources.get(uri) ?? findResourceTarget(candidate, uri);
      if (!target) continue;
      await clientFor(runtime, target.entry, proxy, candidate)
        .then((client) => client.unsubscribeResource({ uri: target.uri }))
        .catch(() => undefined);
    }
  };
  server.setRequestHandler("tools/list", () => listTools(runtime, proxy, generation));
  server.setRequestHandler("tools/call", async (request, context) => {
    const target = findNamespacedTarget(generation, String(request.params.name));
    if (!target) throw new Error(`Unknown MCP catalog tool '${String(request.params.name)}'.`);
    if (generation.entryCapabilities.get(String(target.entry.logicalServerId))?.tools === undefined)
      throw new Error(`MCP catalog tool '${String(request.params.name)}' is unavailable.`);
    return clientFor(runtime, target.entry, proxy, generation).then((client) =>
      client
        .callTool({ ...request.params, name: target.name }, { signal: context.mcpReq.signal })
        .then((result) => namespaceContentResult(target.entry.logicalServerId, result)),
    );
  });
  server.setRequestHandler("resources/list", () => listResources(runtime, proxy, generation));
  server.setRequestHandler("resources/templates/list", () =>
    listResourceTemplates(runtime, proxy, generation),
  );
  server.setRequestHandler("resources/read", async (request, context) => {
    const target =
      generation.resources.get(String(request.params.uri)) ??
      findResourceTarget(generation, String(request.params.uri));
    if (!target) throw new Error(`Unknown MCP catalog resource '${String(request.params.uri)}'.`);
    if (
      generation.entryCapabilities.get(String(target.entry.logicalServerId))?.resources ===
      undefined
    )
      throw new Error(`MCP catalog resource '${String(request.params.uri)}' is unavailable.`);
    return clientFor(runtime, target.entry, proxy, generation).then((client) =>
      client
        .readResource({ ...request.params, uri: target.uri }, { signal: context.mcpReq.signal })
        .then((result) => namespaceContentResult(target.entry.logicalServerId, result)),
    );
  });
  {
    const owner = server;
    server.setRequestHandler("resources/subscribe", async (request, context) => {
      const target =
        generation.resources.get(String(request.params.uri)) ??
        findResourceTarget(generation, String(request.params.uri));
      if (!target) throw new Error(`Unknown MCP catalog resource '${String(request.params.uri)}'.`);
      if (
        generation.entryCapabilities.get(String(target.entry.logicalServerId))?.resources
          ?.subscribe !== true
      )
        throw new Error(
          `MCP catalog resource '${String(request.params.uri)}' is not subscribable.`,
        );
      const owners = generation.resourceSubscriptions.get(String(request.params.uri)) ?? new Set();
      const first = owners.size === 0;
      owners.add(owner);
      generation.resourceSubscriptions.set(String(request.params.uri), owners);
      if (first) {
        try {
          await clientFor(runtime, target.entry, proxy, generation).then((client) =>
            client.subscribeResource({ uri: target.uri }, { signal: context.mcpReq.signal }),
          );
        } catch (cause) {
          owners.delete(owner);
          if (owners.size === 0)
            generation.resourceSubscriptions.delete(String(request.params.uri));
          throw cause;
        }
      }
      return {};
    });
    server.setRequestHandler("resources/unsubscribe", async (request, context) => {
      const target =
        generation.resources.get(String(request.params.uri)) ??
        findResourceTarget(generation, String(request.params.uri));
      if (!target) throw new Error(`Unknown MCP catalog resource '${String(request.params.uri)}'.`);
      if (
        generation.entryCapabilities.get(String(target.entry.logicalServerId))?.resources
          ?.subscribe !== true
      )
        throw new Error(
          `MCP catalog resource '${String(request.params.uri)}' is not subscribable.`,
        );
      const key = String(request.params.uri);
      const owners = generation.resourceSubscriptions.get(key);
      if (!owners?.has(owner)) return {};
      await releaseSubscriptionOwner(key, owner);
      return {};
    });
    // Downstream request streams are the ownership boundary for subscriptions.
    server.onclose = () => {
      const ownedUris = new Set<string>();
      for (const candidate of new Set([generation, runtime.generation])) {
        for (const [key, owners] of candidate.resourceSubscriptions) {
          if (owners.has(owner)) ownedUris.add(key);
        }
      }
      for (const key of ownedUris) void releaseSubscriptionOwner(key, owner);
    };
  }
  server.setRequestHandler("prompts/list", () => listPrompts(runtime, proxy, generation));
  server.setRequestHandler("prompts/get", async (request, context) => {
    const target = findNamespacedTarget(generation, String(request.params.name));
    if (!target) throw new Error(`Unknown MCP catalog prompt '${String(request.params.name)}'.`);
    if (
      generation.entryCapabilities.get(String(target.entry.logicalServerId))?.prompts === undefined
    )
      throw new Error(`MCP catalog prompt '${String(request.params.name)}' is unavailable.`);
    return clientFor(runtime, target.entry, proxy, generation).then((client) =>
      client
        .getPrompt({ ...request.params, name: target.name }, { signal: context.mcpReq.signal })
        .then((result) => namespaceContentResult(target.entry.logicalServerId, result)),
    );
  });
  server.setRequestHandler("ping", () => ({}));
  return server;
};

const make = Effect.gen(function* () {
  const proxy = yield* ProjectMcpProxyRegistry.ProjectMcpProxyRegistry;
  const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
  const base =
    httpServer._tag === "Some" ? baseFromHttpServer(httpServer.value) : "http://127.0.0.1";
  const sessions = yield* Ref.make<ReadonlyMap<string, GatewayRuntime>>(new Map());
  // Staging, disposal, and revocation share one lock. A lifecycle token alone
  // cannot prevent a revoke from racing a slow upstream capability handshake.
  const lifecycleLock = yield* Semaphore.make(1);

  const closeGeneration = async (
    generation: GatewayGeneration,
    proxyProviderSessionId: string,
  ): Promise<void> => {
    for (const [uri, owners] of generation.resourceSubscriptions) {
      if (owners.size === 0) continue;
      const target = generation.resources.get(uri) ?? findResourceTarget(generation, uri);
      if (!target) continue;
      const client = generation.clients.get(String(target.entry.logicalServerId));
      if (client)
        await client
          .then((value) => value.unsubscribeResource({ uri: target.uri }))
          .catch(() => undefined);
    }
    generation.resourceSubscriptions.clear();
    await Promise.allSettled(
      [...generation.clients.values()].map((client) =>
        client.then((value) => value.close()).catch(() => undefined),
      ),
    );
    generation.clients.clear();
    // Cleanup is best-effort: a provider process may already have torn down
    // its proxy lease, but that must not strand the gateway lifecycle lock.
    await Effect.runPromise(proxy.revokeProviderSession(proxyProviderSessionId)).catch(
      () => undefined,
    );
  };

  const retireGeneration = async (
    generation: GatewayGeneration,
    proxyProviderSessionId: string,
  ): Promise<void> => {
    if (generation.closePromise !== undefined) {
      await generation.closePromise;
      return;
    }
    generation.retiring = true;
    const closePromise = (async () => {
      if (generation.activeRequests > 0) {
        await new Promise<void>((resolve) => {
          generation.idle = { resolve };
        });
      }
      await closeGeneration(generation, proxyProviderSessionId);
    })();
    generation.closePromise = closePromise;
    await closePromise;
  };

  const capabilitiesFor = async (
    runtime: GatewayRuntime,
    generation: GatewayGeneration,
  ): Promise<GatewayCapabilities> => {
    let tools: { listChanged?: boolean } | undefined;
    let resources: { listChanged?: boolean; subscribe?: boolean } | undefined;
    let prompts: { listChanged?: boolean } | undefined;
    for (const entry of generation.entries) {
      let entryCapabilities: GatewayEntryCapabilities = {};
      // A generation is not publishable until every selected upstream has
      // completed the MCP handshake. A transient upstream failure must leave
      // the last applied generation serving requests rather than silently
      // publishing a partial catalog.
      const client = await clientFor(runtime, entry, proxy, generation);
      const capabilities = client.getServerCapabilities?.();
      if (capabilities?.tools !== undefined) {
        entryCapabilities = { ...entryCapabilities, tools: capabilities.tools };
        tools ??= {};
        if (capabilities.tools.listChanged === true) tools.listChanged = true;
      }
      if (capabilities?.resources !== undefined) {
        entryCapabilities = { ...entryCapabilities, resources: capabilities.resources };
        resources ??= {};
        if (capabilities.resources.listChanged === true) resources.listChanged = true;
        if (capabilities.resources.subscribe === true) resources.subscribe = true;
      }
      if (capabilities?.prompts !== undefined) {
        entryCapabilities = { ...entryCapabilities, prompts: capabilities.prompts };
        prompts ??= {};
        if (capabilities.prompts.listChanged === true) prompts.listChanged = true;
      }
      generation.entryCapabilities.set(String(entry.logicalServerId), entryCapabilities);
    }
    return {
      ...(tools ? { tools } : {}),
      ...(resources ? { resources } : {}),
      ...(prompts ? { prompts } : {}),
    };
  };

  const stageGeneration = async (
    runtime: GatewayRuntime,
    input: RegisterCatalogSessionInput,
    entries: ReadonlyArray<McpCatalogGatewayEntry>,
    endpoints: ReadonlyArray<ProjectMcpProxyRegistry.ProjectMcpProxyEndpoint>,
    proxyProviderSessionId: string,
    inheritedSubscriptions?: ReadonlyMap<string, Set<object>>,
  ): Promise<GatewayGeneration> => {
    const generation: GatewayGeneration = {
      token: NodeCrypto.randomUUID(),
      providerSessionId: input.providerSessionId,
      providerInstanceId: input.providerInstanceId,
      proxyProviderSessionId,
      revision: input.revision,
      entries,
      endpoints,
      clients: new Map(),
      resources: new Map(),
      resourceSubscriptions: new Map(
        [...(inheritedSubscriptions ?? new Map())].map(([uri, owners]) => [uri, new Set(owners)]),
      ),
      entryCapabilities: new Map(),
      capabilities: {},
      activeRequests: 0,
      retiring: false,
    };
    try {
      // Establish and inspect every upstream before publishing this generation.
      // A partial catalog is never exposed to a provider-facing session.
      const capabilities = await capabilitiesFor(runtime, generation);
      generation.capabilities = capabilities;
      for (const [exposedUri, owners] of generation.resourceSubscriptions) {
        if (owners.size === 0) continue;
        const target = findResourceTarget(generation, exposedUri);
        if (!target) {
          generation.resourceSubscriptions.delete(exposedUri);
          continue;
        }
        if (
          generation.entryCapabilities.get(String(target.entry.logicalServerId))?.resources
            ?.subscribe !== true
        )
          throw new Error("The replacement MCP catalog no longer supports resource subscriptions.");
        await clientFor(runtime, target.entry, proxy, generation).then((client) =>
          client.subscribeResource({ uri: target.uri }),
        );
      }
      return generation;
    } catch (cause) {
      await Promise.allSettled(
        [...generation.clients.values()].map((client) =>
          client.then((value) => value.close()).catch(() => undefined),
        ),
      );
      generation.clients.clear();
      throw cause;
    }
  };

  const registerUnlocked = (input: RegisterCatalogSessionInput) =>
    Effect.gen(function* () {
      const entries = yield* Effect.try({
        try: () => aggregateCatalog(input.entries),
        catch: (error) =>
          error instanceof McpCatalogGatewayCollisionError
            ? error
            : new McpCatalogGatewayCollisionError([]),
      });
      const key = String(input.catalogSessionId);
      const current = (yield* Ref.get(sessions)).get(key);
      // Every revision receives a private proxy lease. The old generation is
      // retired only after the new one has connected and been atomically staged.
      const proxyProviderSessionId = `catalog:${input.providerSessionId}:${key}:${NodeCrypto.randomUUID()}`;
      const resolveSecret = input.resolveSecret ?? current?.resolveSecret;
      const oauthStateLeases = input.oauthStateLeases ?? current?.oauthStateLeases;
      const endpoints = yield* proxy.registerSession({
        providerSessionId: proxyProviderSessionId,
        threadId: input.threadId,
        servers: entries.map((entry) => ({
          id: entry.logicalServerId,
          name: entry.exposedName,
          transport: entry.transport,
          transportDefinitionId: entry.transportDefinitionId,
        })),
        ...(resolveSecret === undefined ? {} : { resolveSecret }),
        ...(oauthStateLeases === undefined ? {} : { oauthStateLeases }),
      });
      let runtime = current;
      if (runtime === undefined) {
        const bus = new InMemoryServerEventBus();
        let initialRuntime: GatewayRuntime;
        const handler = createMcpHandler(() => makeServer(initialRuntime, proxy), {
          bus,
          legacy: "reject",
          responseMode: "auto",
        });
        // A placeholder generation is needed while the first generation is
        // connecting; no handler can be served until staging below completes.
        const placeholder: GatewayGeneration = {
          token: "initializing",
          providerSessionId: input.providerSessionId,
          providerInstanceId: input.providerInstanceId,
          proxyProviderSessionId,
          revision: input.revision,
          entries,
          endpoints,
          clients: new Map(),
          resources: new Map(),
          resourceSubscriptions: new Map(),
          entryCapabilities: new Map(),
          capabilities: {},
          activeRequests: 0,
          retiring: false,
        };
        initialRuntime = {
          catalogSessionId: input.catalogSessionId,
          providerSessionId: input.providerSessionId,
          providerInstanceId: input.providerInstanceId,
          revision: input.revision,
          entries,
          endpoints,
          endpoint: `${base}/mcp/catalog/${encodeURIComponent(key)}`,
          proxyProviderSessionId,
          bus,
          handler,
          clients: placeholder.clients,
          resources: placeholder.resources,
          generation: placeholder,
          retiringGenerations: new Map(),
          resolveSecret,
          oauthStateLeases,
        };
        runtime = initialRuntime;
      }
      const staged = yield* Effect.promise(() =>
        stageGeneration(
          runtime!,
          input,
          entries,
          endpoints,
          proxyProviderSessionId,
          current?.generation.resourceSubscriptions,
        ),
      ).pipe(
        Effect.onError(() =>
          proxy.revokeProviderSession(proxyProviderSessionId).pipe(Effect.ignore),
        ),
      );
      const previous = runtime.generation;
      runtime.generation = staged;
      runtime.providerSessionId = input.providerSessionId;
      runtime.providerInstanceId = input.providerInstanceId;
      runtime.revision = staged.revision;
      runtime.entries = staged.entries;
      runtime.endpoints = staged.endpoints;
      runtime.clients = staged.clients;
      runtime.resources = staged.resources;
      runtime.resolveSecret = resolveSecret;
      runtime.oauthStateLeases = oauthStateLeases;
      if (previous.token !== "initializing") {
        if (previous.providerSessionId === staged.providerSessionId) {
          // A same-provider revision can retire immediately once in-flight
          // requests drain. There is no provider replacement to roll back.
          void retireGeneration(previous, previous.proxyProviderSessionId).catch(() => undefined);
        } else {
          // Keep the previous generation addressable until the provider
          // replacement transaction explicitly releases it. If startup of
          // the new provider fails, revokeRuntime can promote this generation
          // without rebuilding upstream clients.
          runtime.retiringGenerations.set(previous.token, previous);
        }
      }
      const latest = yield* Ref.get(sessions);
      yield* Ref.set(sessions, new Map(latest).set(key, runtime));
      publishListChanges(runtime.bus);
      return runtime;
    });

  const register = (input: RegisterCatalogSessionInput) =>
    lifecycleLock.withPermits(1)(registerUnlocked(input));

  const revokeRuntime: McpCatalogGatewayShape["revokeRuntime"] = (providerSessionId) =>
    lifecycleLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(sessions);
        const next = new Map(current);
        const retiring: Array<Promise<void>> = [];
        for (const [key, session] of current) {
          const matchingRetiring = [...session.retiringGenerations.values()].filter(
            (generation) => generation.providerSessionId === providerSessionId,
          );
          for (const generation of matchingRetiring) {
            session.retiringGenerations.delete(generation.token);
            retiring.push(retireGeneration(generation, generation.proxyProviderSessionId));
          }
          if (session.providerSessionId !== providerSessionId) continue;

          const previous = [...session.retiringGenerations.values()].at(-1);
          if (previous !== undefined) {
            // A provider replacement can fail after the candidate catalog has
            // been staged. Promote the retained generation so the old provider
            // keeps a valid endpoint while the candidate is cleaned up.
            session.retiringGenerations.delete(previous.token);
            const candidate = session.generation;
            session.generation = previous;
            session.providerSessionId = previous.providerSessionId;
            session.providerInstanceId = previous.providerInstanceId;
            session.revision = previous.revision;
            session.entries = previous.entries;
            session.endpoints = previous.endpoints;
            session.clients = previous.clients;
            session.resources = previous.resources;
            retiring.push(retireGeneration(candidate, candidate.proxyProviderSessionId));
            continue;
          }

          next.delete(key);
          retiring.push(
            retireGeneration(session.generation, session.generation.proxyProviderSessionId),
          );
          for (const generation of session.retiringGenerations.values()) {
            retiring.push(retireGeneration(generation, generation.proxyProviderSessionId));
          }
          session.retiringGenerations.clear();
          retiring.push(session.handler.close().catch(() => undefined));
        }
        yield* Ref.set(sessions, next);
        yield* Effect.promise(() => Promise.all(retiring).then(() => undefined));
      }),
    );

  const disposeCatalogSession: McpCatalogGatewayShape["disposeCatalogSession"] = (
    catalogSessionId,
  ) =>
    lifecycleLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(sessions);
        const session = current.get(String(catalogSessionId));
        if (!session) return;
        yield* Ref.set(
          sessions,
          new Map([...current].filter(([key]) => key !== String(catalogSessionId))),
        );
        yield* Effect.promise(() =>
          Promise.all([
            session.handler.close().catch(() => undefined),
            retireGeneration(session.generation, session.generation.proxyProviderSessionId),
            ...[...session.retiringGenerations.values()].map((generation) =>
              retireGeneration(generation, generation.proxyProviderSessionId),
            ),
          ]).then(() => undefined),
        );
        session.retiringGenerations.clear();
      }),
    );

  const revokeAll = lifecycleLock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(sessions);
      const retiring: Array<Promise<void>> = [];
      for (const session of current.values()) {
        retiring.push(session.handler.close().catch(() => undefined));
        retiring.push(
          retireGeneration(session.generation, session.generation.proxyProviderSessionId),
        );
        for (const generation of session.retiringGenerations.values()) {
          retiring.push(retireGeneration(generation, generation.proxyProviderSessionId));
        }
        session.retiringGenerations.clear();
      }
      yield* Ref.set(sessions, new Map());
      yield* Effect.promise(() => Promise.all(retiring).then(() => undefined));
    }),
  );

  const handle: McpCatalogGatewayShape["handle"] = (providerSessionId, catalogSessionId, request) =>
    Effect.gen(function* () {
      const runtime = (yield* Ref.get(sessions)).get(String(catalogSessionId));
      if (!runtime || runtime.providerSessionId !== providerSessionId) {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
      }
      // Capture the generation before entering the handler. A swap can happen
      // while `fetch` is suspended; retirement must drain the generation that
      // actually owns this request rather than the newly active one.
      const generation = runtime.generation;
      generation.activeRequests += 1;
      try {
        return yield* Effect.promise(() => runtime.handler.fetch(request));
      } finally {
        generation.activeRequests -= 1;
        if (generation.retiring && generation.activeRequests === 0) generation.idle?.resolve();
      }
    });

  return McpCatalogGateway.of({
    registerCatalogSession: register,
    applyCatalogRevision: register,
    resolveCatalogSession: (catalogSessionId) =>
      Ref.get(sessions).pipe(Effect.map((current) => current.get(String(catalogSessionId)))),
    resolveProviderSession: (providerSessionId, catalogSessionId) =>
      Ref.get(sessions).pipe(
        Effect.map((current) => {
          const session = current.get(String(catalogSessionId));
          return session?.providerSessionId === providerSessionId ? session : undefined;
        }),
      ),
    handle,
    revokeRuntime,
    disposeCatalogSession,
    revokeAll,
  });
});

export const layer = Layer.effect(
  McpCatalogGateway,
  Effect.acquireRelease(make, (gateway) => gateway.revokeAll.pipe(Effect.ignore)),
);

export const __testing = { make };
