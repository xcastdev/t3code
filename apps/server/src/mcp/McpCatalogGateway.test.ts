import {
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  ProviderInstanceId,
  type ResolvedProjectMcpServer,
  ThreadId,
  type ResolvedMcpCatalogEntry,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpCatalogGateway from "./McpCatalogGateway.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";

const provider = ProviderInstanceId.make("codex");
const transport = {
  type: "streamable-http" as const,
  url: "https://weather.example.test/mcp",
  headers: [],
  authorization: { type: "none" as const },
};

const entry = (logicalServerId: string, name: string): ResolvedMcpCatalogEntry => ({
  logicalServerId: McpServerId.make(logicalServerId),
  transportDefinitionId: McpDefinitionId.make(`${logicalServerId}-definition`),
  name,
  transport,
  providerInstanceId: provider,
  scope: "project",
  scopeId: "project-1",
});

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMessage = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
    method: Schema.optional(Schema.String),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const proxy = () => {
  const registerSession: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape["registerSession"] =
    vi.fn((input: { readonly servers: ReadonlyArray<ResolvedProjectMcpServer> }) =>
      Effect.succeed(
        input.servers.map((server) => ({
          endpointHandle: `endpoint-${server.id}`,
          endpoint: new URL(`http://127.0.0.1/mcp/project/${server.id}`),
          id: server.id,
          name: server.name,
        })),
      ),
    );
  const handle: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape["handle"] = (
    _providerSessionId,
    endpointHandle,
    request,
  ) =>
    Effect.promise(async () => {
      const message = decodeMessage(decodeJson(await request.text()));
      return new Response(
        encodeJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2026-07-28",
            supportedVersions: ["2026-07-28"],
            capabilities: {},
            serverInfo: { name: "upstream", version: "1" },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": endpointHandle },
        },
      );
    });
  return {
    registerSession,
    resolve: () => Effect.succeed(null).pipe(Effect.as(undefined)),
    handle,
    revokeProviderSession: vi.fn(() => Effect.void),
    revokeThread: () => Effect.void,
    revokeServer: () => Effect.void,
    revokeOAuthStorage: () => Effect.void,
    revokeAll: Effect.void,
  } satisfies ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape;
};

it("uses deterministic namespaces for names and resources", () => {
  const serverId = McpServerId.make("weather-server");
  expect(McpCatalogGateway.namespaceName(serverId, "forecast")).toBe("mcp_weatherserver__forecast");
  expect(McpCatalogGateway.namespaceResourceUri(serverId, "https://example.test/weather")).toBe(
    `t3-mcp://${serverId}/aHR0cHM6Ly9leGFtcGxlLnRlc3Qvd2VhdGhlcg`,
  );
});

it("keeps resource templates and returned content reversibly namespaced", () => {
  const serverId = McpServerId.make("weather-server");
  const template = "https://example.test/weather/{city}/{format}";
  const exposedTemplate = McpCatalogGateway.namespaceResourceTemplate(serverId, template);
  expect(exposedTemplate).toContain("{city}");
  expect(exposedTemplate).toContain("{format}");
  expect(McpCatalogGateway.denamespaceResourceUri(serverId, exposedTemplate)).toBe(template);
  const plainTemplate = "forecast";
  expect(
    McpCatalogGateway.denamespaceResourceUri(
      serverId,
      McpCatalogGateway.namespaceResourceTemplate(serverId, plainTemplate),
    ),
  ).toBe(plainTemplate);

  const content = McpCatalogGateway.namespaceContentUris(serverId, {
    contents: [
      { type: "resource", uri: "https://example.test/weather/chicago", mimeType: "text/plain" },
      { type: "resource_link", uri: "https://example.test/weather/forecast" },
    ],
  }) as { contents: ReadonlyArray<{ readonly uri: string }> };
  expect(content.contents.map((item) => item.uri)).toEqual([
    McpCatalogGateway.namespaceResourceUri(serverId, "https://example.test/weather/chicago"),
    McpCatalogGateway.namespaceResourceUri(serverId, "https://example.test/weather/forecast"),
  ]);
});

it.effect("keeps the provider MCP session while swapping upstream catalogs", () =>
  Effect.gen(function* () {
    const toolsByServer = new Map<string, ReadonlyArray<{ readonly name: string }>>([
      ["weather", [{ name: "forecast" }]],
    ]);
    const projectProxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape = {
      registerSession: vi.fn(
        (input: { readonly servers: ReadonlyArray<ResolvedProjectMcpServer> }) =>
          Effect.succeed(
            input.servers.map((server) => ({
              endpointHandle: `endpoint-${server.id}`,
              endpoint: new URL(`http://127.0.0.1/mcp/project/${server.id}`),
              id: server.id,
              name: server.name,
            })),
          ),
      ),
      resolve: () => Effect.succeed(undefined),
      handle: (_providerSessionId, endpointHandle, request) =>
        Effect.promise(async () => {
          const message = decodeMessage(decodeJson(await request.text()));
          if (message.method === "server/discover") {
            return new Response(
              encodeJson({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2026-07-28",
                  supportedVersions: ["2026-07-28"],
                  capabilities: { tools: { listChanged: true } },
                  serverInfo: { name: "upstream", version: "1" },
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json", "mcp-session-id": endpointHandle },
              },
            );
          }
          if (message.method === "tools/list") {
            const serverId = endpointHandle.slice("endpoint-".length);
            return new Response(
              encodeJson({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: (toolsByServer.get(serverId) ?? []).map((tool) => ({
                    ...tool,
                    inputSchema: { type: "object" },
                  })),
                  resultType: "complete",
                  ttlMs: 0,
                  cacheScope: "private",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (message.method === "tools/call") {
            return new Response(
              encodeJson({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [{ type: "text", text: `called:${String(message.id)}` }],
                  isError: false,
                  resultType: "complete",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(encodeJson({ jsonrpc: "2.0", id: message.id, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      revokeProviderSession: vi.fn(() => Effect.void),
      revokeThread: () => Effect.void,
      revokeServer: () => Effect.void,
      revokeOAuthStorage: () => Effect.void,
      revokeAll: Effect.void,
    };
    const gateway = yield* McpCatalogGateway.__testing.make.pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, projectProxy),
    );
    const catalogSessionId = McpCatalogSessionId.make("catalog-live");
    const providerInstanceId = provider;
    const first = yield* gateway.registerCatalogSession({
      catalogSessionId,
      providerSessionId: "provider-live",
      threadId: ThreadId.make("thread-live"),
      providerInstanceId,
      revision: 1,
      entries: [entry("weather", "Weather")],
    });
    const downstream = new Client(
      { name: "gateway-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const downstreamTransport = new StreamableHTTPClientTransport(new URL(first.endpoint), {
      fetch: (url, init) =>
        Effect.runPromise(
          gateway.handle("provider-live", catalogSessionId, new Request(url, init)),
        ),
    });
    yield* Effect.promise(() => downstream.connect(downstreamTransport));
    const firstTools = yield* Effect.promise(() => downstream.listTools());
    expect(firstTools.tools.map((tool) => tool.name)).toEqual(["mcp_weather__forecast"]);
    const called = yield* Effect.promise(() =>
      downstream.callTool({ name: "mcp_weather__forecast", arguments: {} }),
    );
    expect(called.isError).toBe(false);

    toolsByServer.set("weather", [{ name: "updated" }]);
    yield* gateway.applyCatalogRevision({
      catalogSessionId,
      providerSessionId: "provider-live",
      threadId: ThreadId.make("thread-live"),
      providerInstanceId,
      revision: 2,
      entries: [entry("weather", "Weather")],
    });
    const changedTools = yield* Effect.promise(() => downstream.listTools());
    expect(changedTools.tools.map((tool) => tool.name)).toEqual(["mcp_weather__updated"]);
    yield* Effect.promise(() => downstream.close());
  }),
);

it.effect("keeps a previous provider generation available during replacement rollback", () =>
  Effect.gen(function* () {
    const projectProxy = proxy();
    const gateway = yield* McpCatalogGateway.__testing.make.pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, projectProxy),
    );
    const catalogSessionId = McpCatalogSessionId.make("catalog-provider-replace");
    const base = {
      catalogSessionId,
      threadId: ThreadId.make("thread-provider-replace"),
      providerInstanceId: provider,
      revision: 1,
      entries: [entry("weather", "forecast")],
    } as const;
    yield* gateway.registerCatalogSession({ ...base, providerSessionId: "provider-old" });
    yield* gateway.applyCatalogRevision({
      ...base,
      providerSessionId: "provider-new",
      revision: 2,
    });
    expect(yield* gateway.resolveProviderSession("provider-old", catalogSessionId)).toBeUndefined();
    expect(yield* gateway.resolveProviderSession("provider-new", catalogSessionId)).toBeDefined();

    yield* gateway.revokeRuntime("provider-new");
    expect(yield* gateway.resolveProviderSession("provider-new", catalogSessionId)).toBeUndefined();
    expect(yield* gateway.resolveProviderSession("provider-old", catalogSessionId)).toBeDefined();
    expect(projectProxy.revokeProviderSession).toHaveBeenCalled();

    yield* gateway.revokeRuntime("provider-old");
    expect(yield* gateway.resolveCatalogSession(catalogSessionId)).toBeUndefined();
  }),
);

it("detects namespaced item and resource URI collisions", () => {
  expect(() =>
    McpCatalogGateway.aggregateCatalog([
      entry("weather", "forecast"),
      entry("weather", "forecast"),
    ]),
  ).toThrow(McpCatalogGateway.McpCatalogGatewayCollisionError);
  expect(() =>
    McpCatalogGateway.aggregateResourceUris([
      { logicalServerId: McpServerId.make("weather"), upstreamUri: "memory://forecast" },
      { logicalServerId: McpServerId.make("weather"), upstreamUri: "memory://forecast" },
    ]),
  ).toThrow(McpCatalogGateway.McpCatalogGatewayCollisionError);
});

it.effect("advertises a stable empty gateway and accepts list requests", () =>
  Effect.gen(function* () {
    const projectProxy = proxy();
    const gateway = yield* McpCatalogGateway.__testing.make.pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, projectProxy),
    );
    const catalogSessionId = McpCatalogSessionId.make("catalog-empty");
    const registered = yield* gateway.registerCatalogSession({
      catalogSessionId,
      providerSessionId: "provider-empty",
      threadId: ThreadId.make("thread-empty"),
      providerInstanceId: provider,
      revision: 0,
      entries: [],
    });
    const downstream = new Client(
      { name: "empty-gateway-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(registered.endpoint), {
      fetch: (url, init) =>
        Effect.runPromise(
          gateway.handle("provider-empty", catalogSessionId, new Request(url, init)),
        ),
    });
    yield* Effect.promise(() => downstream.connect(transport));
    expect((yield* Effect.promise(() => downstream.listTools())).tools).toEqual([]);
    expect((yield* Effect.promise(() => downstream.listResources())).resources).toEqual([]);
    expect((yield* Effect.promise(() => downstream.listPrompts())).prompts).toEqual([]);
    yield* Effect.promise(() => downstream.close());
    yield* gateway.revokeRuntime("provider-empty");
  }),
);

it.effect("registers and swaps a catalog revision through the project proxy", () =>
  Effect.gen(function* () {
    const projectProxy = proxy();
    const gateway = yield* McpCatalogGateway.__testing.make.pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, projectProxy),
    );
    const input = {
      catalogSessionId: McpCatalogSessionId.make("catalog-1"),
      providerSessionId: "provider-1",
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: provider,
      revision: 1,
      entries: [entry("weather", "forecast")],
    };
    const first = yield* gateway.registerCatalogSession(input);
    expect(first.entries[0]?.exposedName).toBe("mcp_weather__forecast");
    expect(first.endpoints[0]?.name).toBe("mcp_weather__forecast");

    const second = yield* gateway.applyCatalogRevision({
      ...input,
      revision: 2,
      entries: [entry("weather", "forecast"), entry("search", "query")],
    });
    expect(second.revision).toBe(2);
    expect((yield* gateway.resolveCatalogSession(input.catalogSessionId))?.revision).toBe(2);
    expect(projectProxy.registerSession).toHaveBeenCalledTimes(2);
  }),
);
