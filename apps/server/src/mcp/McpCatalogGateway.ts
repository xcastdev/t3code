import * as AssistantResources from "../assistants/AssistantNativeResources.ts";
import type {
  McpCatalogSessionId,
  ProviderInstanceId,
  ResolvedMcpCatalogEntry,
  ThreadId,
} from "@t3tools/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Registry from "./McpSessionRegistry.ts";
import * as Proxy from "./ProjectMcpProxyRegistry.ts";
import {
  namespaceName,
  namespaceResourceUri,
  namespaceResourceTemplate,
  denamespaceResourceUri,
  namespaceContentUris,
} from "./ProjectMcpBroker.ts";
export {
  namespaceName,
  namespaceResourceUri,
  namespaceResourceTemplate,
  denamespaceResourceUri,
  namespaceContentUris,
} from "./ProjectMcpBroker.ts";

export interface RegisterCatalogSessionInput {
  readonly catalogSessionId: McpCatalogSessionId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly runtimeId: string;
  readonly revision: number;
  readonly entries: ReadonlyArray<ResolvedMcpCatalogEntry>;
}
export interface McpCatalogGatewaySession extends RegisterCatalogSessionInput {}
export class McpCatalogGatewayError extends Error {
  readonly _tag = "McpCatalogGatewayError";
  constructor() {
    super("MCP catalog apply failed.");
  }
}
export interface McpCatalogGatewayShape {
  readonly registerCatalogSession: (
    input: RegisterCatalogSessionInput,
  ) => Effect.Effect<McpCatalogGatewaySession, McpCatalogGatewayError>;
  readonly applyCatalogRevision: (
    input: RegisterCatalogSessionInput,
  ) => Effect.Effect<McpCatalogGatewaySession, McpCatalogGatewayError>;
  readonly resolveCatalogSession: (
    id: McpCatalogSessionId,
  ) => Effect.Effect<McpCatalogGatewaySession | undefined>;
  readonly resolveProviderSession: (
    identity: string,
    id: McpCatalogSessionId,
  ) => Effect.Effect<McpCatalogGatewaySession | undefined>;
  readonly handle: (
    identity: string,
    pathIdentity: string,
    request: Request,
  ) => Effect.Effect<Response>;
  readonly revokeRuntime: (identity: string) => Effect.Effect<void>;
  readonly disposeCatalogSession: (id: McpCatalogSessionId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}
export class McpCatalogGateway extends Context.Service<McpCatalogGateway, McpCatalogGatewayShape>()(
  "t3/mcp/McpCatalogGateway",
) {}
interface Generation {
  readonly session: McpCatalogGatewaySession;
  readonly scope: Scope.Closeable;
  readonly connections: ReadonlyArray<Proxy.ProjectMcpConnection>;
  active: number;
  retired: boolean;
  drained?: () => void;
}
const unauthorized = () =>
  new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
const MAX_DISCOVERY_PAGES = 100;
const MAX_DISCOVERY_ITEMS = 10_000;
const collectCatalogPages = async <A>(
  load: (
    cursor?: string,
  ) => Promise<{ readonly items: ReadonlyArray<A>; readonly nextCursor?: string | undefined }>,
): Promise<ReadonlyArray<A>> => {
  const items: A[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < MAX_DISCOVERY_PAGES; pageCount += 1) {
    const page = await load(cursor).catch(() => {
      throw new Error("MCP upstream request failed.");
    });
    items.push(...page.items);
    if (items.length > MAX_DISCOVERY_ITEMS)
      throw new Error("MCP upstream discovery limit exceeded.");
    cursor = page.nextCursor;
    if (!cursor) return items;
    if (cursors.has(cursor)) throw new Error("MCP upstream repeated a cursor.");
    cursors.add(cursor);
  }
  throw new Error("MCP upstream discovery limit exceeded.");
};
const makeServer = (
  generation: Generation,
  policy: () => Promise<ReadonlyArray<string> | undefined>,
) => {
  const server = new Server(
    { name: "t3-catalog", version: "1" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const named = (name: string) => {
    for (const connection of generation.connections) {
      const prefix = namespaceName(connection.entry.logicalServerId, "");
      if (name.startsWith(prefix) && name.length > prefix.length)
        return { ...connection, name: name.slice(prefix.length) };
    }
    throw new Error("Unknown MCP catalog item.");
  };
  const resource = (uri: string) => {
    for (const connection of generation.connections) {
      const upstream = denamespaceResourceUri(connection.entry.logicalServerId, uri);
      if (upstream !== undefined) return { ...connection, uri: upstream };
    }
    throw new Error("Unknown MCP catalog resource.");
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allowed = await policy();
    const tools = [];
    for (const { entry, client } of generation.connections) {
      if (!client.getServerCapabilities()?.tools) continue;
      const upstream = await collectCatalogPages(async (cursor) => {
        const page = await client.listTools(cursor ? { cursor } : {});
        return { items: page.tools, nextCursor: page.nextCursor };
      });
      tools.push(
        ...upstream
          .filter(
            (tool) =>
              allowed === undefined ||
              allowed.includes(`${entry.transportDefinitionId}:${tool.name}`),
          )
          .map((tool) => ({
            ...tool,
            name: namespaceName(entry.logicalServerId, tool.name),
          })),
      );
      if (tools.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const target = named(request.params.name);
    const allowed = await policy();
    if (
      allowed !== undefined &&
      !allowed.includes(`${target.entry.transportDefinitionId}:${target.name}`)
    )
      throw new Error("This tool is not selected in the assistant configuration.");
    const result = await target.client
      .callTool({ ...request.params, name: target.name }, undefined, { signal: extra.signal })
      .catch(() => {
        throw new Error("MCP upstream request failed.");
      });
    return namespaceContentUris(target.entry.logicalServerId, result) as typeof result;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if ((await policy()) !== undefined) return { resources: [] };
    const resources = [];
    for (const { entry, client } of generation.connections) {
      if (!client.getServerCapabilities()?.resources) continue;
      const upstream = await collectCatalogPages(async (cursor) => {
        const page = await client.listResources(cursor ? { cursor } : {});
        return { items: page.resources, nextCursor: page.nextCursor };
      });
      resources.push(
        ...upstream.map((item) => ({
          ...item,
          uri: namespaceResourceUri(entry.logicalServerId, item.uri),
          name: namespaceName(entry.logicalServerId, item.name),
        })),
      );
      if (resources.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    return { resources };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    if ((await policy()) !== undefined) return { resourceTemplates: [] };
    const resourceTemplates = [];
    for (const { entry, client } of generation.connections) {
      if (!client.getServerCapabilities()?.resources) continue;
      const upstream = await collectCatalogPages(async (cursor) => {
        const page = await client.listResourceTemplates(cursor ? { cursor } : {});
        return { items: page.resourceTemplates, nextCursor: page.nextCursor };
      });
      resourceTemplates.push(
        ...upstream.map((item) => ({
          ...item,
          uriTemplate: namespaceResourceTemplate(entry.logicalServerId, item.uriTemplate),
          name: namespaceName(entry.logicalServerId, item.name),
        })),
      );
      if (resourceTemplates.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    return { resourceTemplates };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    if ((await policy()) !== undefined)
      throw new Error("Assistant resource access requires a configured selection.");
    const target = resource(request.params.uri);
    const result = await target.client
      .readResource({ uri: target.uri }, { signal: extra.signal })
      .catch(() => {
        throw new Error("MCP upstream request failed.");
      });
    return namespaceContentUris(target.entry.logicalServerId, result) as typeof result;
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if ((await policy()) !== undefined) return { prompts: [] };
    const prompts = [];
    for (const { entry, client } of generation.connections) {
      if (!client.getServerCapabilities()?.prompts) continue;
      const upstream = await collectCatalogPages(async (cursor) => {
        const page = await client.listPrompts(cursor ? { cursor } : {});
        return { items: page.prompts, nextCursor: page.nextCursor };
      });
      prompts.push(
        ...upstream.map((item) => ({
          ...item,
          name: namespaceName(entry.logicalServerId, item.name),
        })),
      );
      if (prompts.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    return { prompts };
  });
  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    if ((await policy()) !== undefined)
      throw new Error("Assistant prompt access requires a configured selection.");
    const target = named(request.params.name);
    const result = await target.client
      .getPrompt({ ...request.params, name: target.name }, { signal: extra.signal })
      .catch(() => {
        throw new Error("MCP upstream request failed.");
      });
    return namespaceContentUris(target.entry.logicalServerId, result) as typeof result;
  });
  return server;
};

const make = Effect.gen(function* () {
  const resourcePolicy = yield* AssistantResources.AssistantNativeResources;
  const proxy = yield* Proxy.ProjectMcpProxyRegistry;
  const registry = yield* Registry.McpSessionRegistry;
  const sessions = new Map<McpCatalogSessionId, Generation>();
  const stages = new Set<{ readonly input: RegisterCatalogSessionInput; revoked: boolean }>();
  const lock = yield* Semaphore.make(1);
  const valid = (input: RegisterCatalogSessionInput) =>
    registry
      .resolveNativeRuntime(input.providerSessionId)
      .pipe(
        Effect.map(
          (binding) =>
            binding?.runtimeId === input.runtimeId &&
            binding.threadId === input.threadId &&
            binding.providerInstanceId === input.providerInstanceId,
        ),
      );
  const retire = Effect.fn("McpCatalogGateway.retire")(function* (generation: Generation) {
    generation.retired = true;
    // Bounded retirement keeps a stuck upstream from retaining secret leases forever.
    if (generation.active)
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            generation.drained = resolve;
          }),
      ).pipe(Effect.timeoutOption("5 seconds"));
    yield* Scope.close(generation.scope, Exit.void).pipe(Effect.timeoutOption("5 seconds"));
  });
  const remove = Effect.fn("McpCatalogGateway.remove")(function* (
    predicate: (generation: Generation) => boolean,
  ) {
    const retiring = [...sessions.entries()].filter(([, generation]) => predicate(generation));
    for (const [id] of retiring) sessions.delete(id);
    yield* Effect.forEach(retiring, ([, generation]) => retire(generation), {
      concurrency: "unbounded",
      discard: true,
    });
  });
  const applyUnlocked = Effect.fn("McpCatalogGateway.apply")(
    function* (input: RegisterCatalogSessionInput) {
      const stage = { input, revoked: false };
      stages.add(stage);
      try {
        if (!(yield* valid(input))) return yield* Effect.fail(new McpCatalogGatewayError());
        const ids = new Set(input.entries.map((entry) => entry.logicalServerId));
        if (
          ids.size !== input.entries.length ||
          input.entries.length > 50 ||
          input.entries.some((entry) => entry.providerInstanceId !== input.providerInstanceId)
        )
          return yield* Effect.fail(new McpCatalogGatewayError());
        const installed = sessions.get(input.catalogSessionId);
        if (
          (installed &&
            (installed.session.threadId !== input.threadId ||
              installed.session.providerInstanceId !== input.providerInstanceId ||
              installed.session.revision > input.revision)) ||
          [...sessions.values()].some(
            (candidate) =>
              candidate.session.providerSessionId === input.providerSessionId &&
              candidate.session.catalogSessionId !== input.catalogSessionId,
          )
        )
          return yield* Effect.fail(new McpCatalogGatewayError());
        const scope = yield* Scope.make("parallel");
        const connections = yield* Effect.forEach(
          input.entries,
          (entry) =>
            Effect.gen(function* () {
              const connectionScope = yield* Scope.fork(scope, "sequential");
              return yield* proxy
                .connect(entry)
                .pipe(Effect.provideService(Scope.Scope, connectionScope));
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        if (!(yield* valid(input)) || stage.revoked) {
          yield* Scope.close(scope, Exit.void);
          return yield* Effect.fail(new McpCatalogGatewayError());
        }
        const previous = sessions.get(input.catalogSessionId);
        const generation: Generation = {
          session: { ...input, entries: [...input.entries] },
          scope,
          connections,
          active: 0,
          retired: false,
        };
        sessions.set(input.catalogSessionId, generation);
        if (previous) yield* retire(previous);
        return generation.session;
      } finally {
        stages.delete(stage);
      }
    },
    Effect.mapError(() => new McpCatalogGatewayError()),
  );
  const apply = (input: RegisterCatalogSessionInput) => lock.withPermits(1)(applyUnlocked(input));
  const revokeRuntime = (identity: string) =>
    Effect.suspend(() => {
      for (const stage of stages)
        if (stage.input.providerSessionId === identity) stage.revoked = true;
      return remove((generation) => generation.session.providerSessionId === identity);
    });
  const disposeCatalogSession = (id: McpCatalogSessionId) =>
    Effect.suspend(() => {
      for (const stage of stages) if (stage.input.catalogSessionId === id) stage.revoked = true;
      return remove((generation) => generation.session.catalogSessionId === id);
    });
  const revokeAll = Effect.suspend(() => {
    for (const stage of stages) stage.revoked = true;
    return remove(() => true);
  });
  yield* Effect.acquireRelease(registry.onRevoke(revokeRuntime), (dispose) => Effect.sync(dispose));
  yield* Effect.addFinalizer(() => revokeAll);
  return McpCatalogGateway.of({
    registerCatalogSession: apply,
    applyCatalogRevision: apply,
    resolveCatalogSession: (id) => Effect.sync(() => sessions.get(id)?.session),
    resolveProviderSession: (identity, id) =>
      Effect.sync(() => {
        const session = sessions.get(id)?.session;
        return session?.providerSessionId === identity ? session : undefined;
      }),
    revokeRuntime,
    disposeCatalogSession,
    revokeAll,
    handle: Effect.fn("McpCatalogGateway.handle")(function* (identity, pathIdentity, request) {
      if (identity !== pathIdentity) return unauthorized();
      const binding = yield* registry.resolveNativeRuntime(identity);
      if (!binding) return unauthorized();
      const generation = [...sessions.values()].find(
        (candidate) => candidate.session.providerSessionId === identity,
      );
      if (generation && (!(yield* valid(generation.session)) || generation.retired))
        return unauthorized();
      // Native clients can initialize their stable endpoint before the first apply.
      const emptyScope = generation ? undefined : yield* Scope.make();
      const active = generation ?? {
        session: {
          catalogSessionId: pathIdentity as McpCatalogSessionId,
          threadId: binding.threadId,
          providerInstanceId: binding.providerInstanceId,
          providerSessionId: identity,
          runtimeId: binding.runtimeId,
          revision: 0,
          entries: [],
        },
        scope: emptyScope!,
        connections: [],
        active: 0,
        retired: false,
      };
      active.active += 1;
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = makeServer(active, () =>
        Effect.runPromise(
          resourcePolicy.tools(active.session.threadId, active.session.providerSessionId),
        ),
      );
      return yield* Effect.tryPromise({
        try: async () => {
          await server.connect(transport);
          return transport.handleRequest(request);
        },
        catch: () => new McpCatalogGatewayError(),
      }).pipe(
        Effect.catch(() => Effect.succeed(new Response(null, { status: 502 }))),
        Effect.ensuring(
          Effect.promise(() => server.close().catch(() => undefined)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                active.active -= 1;
                if (!active.active) active.drained?.();
              }),
            ),
          ),
        ),
        Effect.ensuring(emptyScope ? Scope.close(emptyScope, Exit.void) : Effect.void),
      );
    }),
  });
});
export const layer = Layer.effect(McpCatalogGateway, make).pipe(
  Layer.provide(AssistantResources.layer),
);
export const __testing = { make };
