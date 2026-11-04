import * as AssistantResources from "../assistants/AssistantNativeResources.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PluginService from "../plugins/PluginService.ts";
import {
  EMPTY_PLUGIN_CALL_CONTEXT,
  PLUGIN_LIMITS,
  PluginRequestError,
  type McpCatalogSessionId,
  type PluginId,
  type ProviderInstanceId,
  type ResolvedMcpCatalogEntry,
  type ThreadId,
} from "@t3tools/contracts";
import {
  parsePluginResourceUri,
  parsePluginToolName,
  pluginAgentTools,
  pluginResourceUri,
  pluginToolPolicyKey,
} from "@t3tools/shared/pluginManifest";
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
  CancelledNotificationSchema,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Registry from "./McpSessionRegistry.ts";
import * as Proxy from "./ProjectMcpProxyRegistry.ts";
import {
  catalogAliases,
  namespaceName,
  namespaceResourceUri,
  namespaceResourceTemplate,
  denamespaceResourceUri,
  namespaceContentUris,
  splitNamespacedName,
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
export const PLUGIN_MUTATION_REFUSED_MESSAGE =
  "This tool changes state; the thread needs full access.";
const UNKNOWN_ITEM_MESSAGE = "Unknown MCP catalog item.";
const UNKNOWN_RESOURCE_MESSAGE = "Unknown MCP catalog resource.";
const ASSISTANT_TOOL_REFUSED_MESSAGE = "This tool is not selected in the assistant configuration.";
const ASSISTANT_RESOURCE_REFUSED_MESSAGE =
  "Assistant resource access requires a configured selection.";
class McpCatalogPluginRefusal extends Error {
  readonly _tag = "McpCatalogPluginRefusal";
}
interface PluginSource {
  readonly catalog: () => Promise<ReadonlyArray<PluginService.PluginAgentCatalogEntry>>;
  /** Resolves to the operation's JSON result text; rejects with the refusal the agent sees. */
  readonly call: (
    request: {
      readonly pluginId: PluginId;
      readonly target:
        | { readonly kind: "tool"; readonly operation: string; readonly input: unknown }
        | { readonly kind: "resource"; readonly name: string };
    },
    signal: AbortSignal,
  ) => Promise<string>;
}
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
// A resource reads through an agent operation, so a panel-only operation is never exposed.
const readableResources = (entry: PluginService.PluginAgentCatalogEntry) =>
  entry.resources.filter((item) =>
    entry.operations.some((operation) => operation.name === item.operation && operation.agent),
  );
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
  plugins: PluginSource,
  inflight: Map<RequestId, AbortController>,
) => {
  const server = new Server(
    { name: "t3-catalog", version: "1" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  // Each HTTP request gets its own Server, so a cancel notification arrives on a different
  // instance than the call it names; the session-wide map lets it reach that call.
  server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
    const { requestId, reason } = notification.params;
    if (requestId !== undefined) inflight.get(requestId)?.abort(reason);
  });
  const cancellable = async <A>(
    extra: { readonly requestId: RequestId; readonly signal: AbortSignal },
    run: (signal: AbortSignal) => Promise<A>,
  ) => {
    const controller = new AbortController();
    inflight.set(extra.requestId, controller);
    try {
      return await run(AbortSignal.any([extra.signal, controller.signal]));
    } finally {
      if (inflight.get(extra.requestId) === controller) inflight.delete(extra.requestId);
    }
  };
  const aliases = catalogAliases(generation.connections.map((connection) => connection.entry));
  const alias = (entry: ResolvedMcpCatalogEntry) => aliases.get(entry.logicalServerId)!;
  const byAlias = new Map(
    generation.connections.map((connection) => [alias(connection.entry), connection]),
  );
  const named = (name: string) => {
    const parts = splitNamespacedName(name);
    const connection = parts && byAlias.get(parts.alias);
    if (parts === undefined || connection === undefined)
      throw new Error("Unknown MCP catalog item.");
    return { ...connection, name: parts.name };
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
            name: namespaceName(alias(entry), tool.name),
          })),
      );
      if (tools.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    for (const entry of await plugins.catalog())
      tools.push(
        ...pluginAgentTools({
          id: entry.pluginId,
          backend: {
            operations: entry.operations.filter(
              (operation) =>
                allowed === undefined ||
                allowed.includes(pluginToolPolicyKey(entry.pluginId, operation.name)),
            ),
          },
        }),
      );
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    cancellable(extra, async (signal) => {
      const plugin = parsePluginToolName(request.params.name);
      if (plugin !== undefined) {
        const allowed = await policy();
        if (
          allowed !== undefined &&
          !allowed.includes(pluginToolPolicyKey(plugin.pluginId, plugin.operation))
        )
          throw new Error(ASSISTANT_TOOL_REFUSED_MESSAGE);
        const text = await plugins.call(
          {
            pluginId: plugin.pluginId,
            target: {
              kind: "tool",
              operation: plugin.operation,
              input: request.params.arguments ?? {},
            },
          },
          signal,
        );
        return { content: [{ type: "text" as const, text }] };
      }
      const target = named(request.params.name);
      const allowed = await policy();
      if (
        allowed !== undefined &&
        !allowed.includes(`${target.entry.transportDefinitionId}:${target.name}`)
      )
        throw new Error(ASSISTANT_TOOL_REFUSED_MESSAGE);
      const result = await target.client
        .callTool({ ...request.params, name: target.name }, undefined, { signal })
        .catch(() => {
          throw new Error("MCP upstream request failed.");
        });
      return namespaceContentUris(target.entry.logicalServerId, result) as typeof result;
    }),
  );
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
          name: namespaceName(alias(entry), item.name),
        })),
      );
      if (resources.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    for (const entry of await plugins.catalog())
      resources.push(
        ...readableResources(entry).map((item) => ({
          uri: pluginResourceUri(entry.pluginId, item.name),
          name: item.name,
          title: item.title,
          mimeType: "application/json",
        })),
      );
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
          name: namespaceName(alias(entry), item.name),
        })),
      );
      if (resourceTemplates.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    return { resourceTemplates };
  });
  server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
    cancellable(extra, async (signal) => {
      if ((await policy()) !== undefined) throw new Error(ASSISTANT_RESOURCE_REFUSED_MESSAGE);
      const plugin = parsePluginResourceUri(request.params.uri);
      if (plugin !== undefined) {
        const text = await plugins.call(
          { pluginId: plugin.pluginId, target: { kind: "resource", name: plugin.name } },
          signal,
        );
        return { contents: [{ uri: request.params.uri, mimeType: "application/json", text }] };
      }
      const target = resource(request.params.uri);
      const result = await target.client.readResource({ uri: target.uri }, { signal }).catch(() => {
        throw new Error("MCP upstream request failed.");
      });
      return namespaceContentUris(target.entry.logicalServerId, result) as typeof result;
    }),
  );
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
          name: namespaceName(alias(entry), item.name),
        })),
      );
      if (prompts.length > MAX_DISCOVERY_ITEMS)
        throw new Error("MCP upstream discovery limit exceeded.");
    }
    return { prompts };
  });
  server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
    cancellable(extra, async (signal) => {
      if ((await policy()) !== undefined)
        throw new Error("Assistant prompt access requires a configured selection.");
      const target = named(request.params.name);
      const result = await target.client
        .getPrompt({ ...request.params, name: target.name }, { signal })
        .catch(() => {
          throw new Error("MCP upstream request failed.");
        });
      return namespaceContentUris(target.entry.logicalServerId, result) as typeof result;
    }),
  );
  return server;
};

const make = Effect.gen(function* () {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const resourcePolicy = yield* AssistantResources.AssistantNativeResources;
  const proxy = yield* Proxy.ProjectMcpProxyRegistry;
  const registry = yield* Registry.McpSessionRegistry;
  const plugins = yield* PluginService.PluginService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const unavailablePlugin = (pluginId: PluginId, missing: string) =>
    Effect.flatMap(plugins.list, (snapshot) => {
      const record = snapshot.installed.find((candidate) => candidate.pluginId === pluginId);
      return Effect.fail(
        new McpCatalogPluginRefusal(
          record !== undefined && !record.enabled
            ? `Plugin "${record.name}" is disabled.`
            : missing,
        ),
      );
    });
  const callPlugin = Effect.fn("McpCatalogGateway.callPlugin")(function* (
    threadId: ThreadId,
    request: Parameters<PluginSource["call"]>[0],
  ) {
    const { pluginId, target } = request;
    yield* Effect.annotateCurrentSpan({ pluginId, kind: target.kind });
    const missing = target.kind === "tool" ? UNKNOWN_ITEM_MESSAGE : UNKNOWN_RESOURCE_MESSAGE;
    const entry = (yield* plugins.agentCatalog).find(
      (candidate) => candidate.pluginId === pluginId,
    );
    if (entry === undefined) return yield* unavailablePlugin(pluginId, missing);
    const operationName =
      target.kind === "tool"
        ? target.operation
        : readableResources(entry).find((item) => item.name === target.name)?.operation;
    if (operationName === undefined)
      return yield* Effect.fail(new McpCatalogPluginRefusal(missing));
    const declared = entry.operations.find(
      (operation) => operation.name === operationName && operation.agent,
    );
    if (declared === undefined)
      return yield* new PluginRequestError({ reason: "unknown-operation" });
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const context = PluginService.pluginCallContextFromShell(shell);
    if (
      declared.mutates &&
      (context === null ||
        shell?.runtimeMode !== "full-access" ||
        shell.interactionMode !== "default")
    )
      return yield* Effect.fail(new McpCatalogPluginRefusal(PLUGIN_MUTATION_REFUSED_MESSAGE));
    const result = yield* plugins
      .callOperation({
        pluginId,
        operation: declared.name,
        input: target.kind === "tool" ? target.input : {},
        caller: "agent",
        context: context ?? EMPTY_PLUGIN_CALL_CONTEXT,
      })
      .pipe(
        Effect.catchTags({
          PluginRequestError: (error) =>
            error.reason === "disabled" ? unavailablePlugin(pluginId, missing) : Effect.fail(error),
        }),
      );
    const text = yield* encodeJson(result ?? null).pipe(
      Effect.mapError(() => new PluginRequestError({ reason: "operation-failed" })),
    );
    if (new TextEncoder().encode(text).byteLength > PLUGIN_LIMITS.maxPayloadBytes)
      return yield* new PluginRequestError({ reason: "too-large" });
    return text;
  });
  const sessions = new Map<McpCatalogSessionId, Generation>();
  const inflight = new Map<string, Map<RequestId, AbortController>>();
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
      inflight.delete(identity);
      return remove((generation) => generation.session.providerSessionId === identity);
    });
  const disposeCatalogSession = (id: McpCatalogSessionId) =>
    Effect.suspend(() => {
      for (const stage of stages) if (stage.input.catalogSessionId === id) stage.revoked = true;
      return remove((generation) => generation.session.catalogSessionId === id);
    });
  const revokeAll = Effect.suspend(() => {
    for (const stage of stages) stage.revoked = true;
    inflight.clear();
    return remove(() => true);
  });
  yield* Effect.acquireRelease(registry.onRevoke(revokeRuntime), (dispose) => Effect.sync(dispose));
  yield* Effect.addFinalizer(() => revokeAll);
  return McpCatalogGateway.of({
    registerCatalogSession: apply,
    applyCatalogRevision: apply,
    resolveCatalogSession: Effect.fn("McpCatalogGateway.resolveCatalogSession")((id) =>
      Effect.sync(() => sessions.get(id)?.session),
    ),
    resolveProviderSession: Effect.fn("McpCatalogGateway.resolveProviderSession")((identity, id) =>
      Effect.sync(() => {
        const session = sessions.get(id)?.session;
        return session?.providerSessionId === identity ? session : undefined;
      }),
    ),
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
      const calls = inflight.get(identity) ?? new Map<RequestId, AbortController>();
      inflight.set(identity, calls);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = makeServer(
        active,
        () =>
          runPromise(
            resourcePolicy.tools(active.session.threadId, active.session.providerSessionId),
          ),
        {
          catalog: () => runPromise(plugins.agentCatalog),
          call: (pluginRequest, signal) =>
            runPromise(callPlugin(active.session.threadId, pluginRequest), { signal }),
        },
        calls,
      );
      return yield* Effect.tryPromise({
        try: async () => {
          await server.connect(transport);
          return transport.handleRequest(request);
        },
        catch: () => new McpCatalogGatewayError(),
      }).pipe(
        Effect.orElseSucceed(() => new Response(null, { status: 502 })),
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
/** Needs `PluginService` from the host, which owns the one set of plugin workers. */
export const layer = Layer.effect(McpCatalogGateway, make).pipe(
  Layer.provide(Layer.merge(AssistantResources.layer, ProjectionStore.layer)),
);
export const __testing = { make };
