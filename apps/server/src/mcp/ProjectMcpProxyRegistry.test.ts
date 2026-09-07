import { McpServerId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import type { ProjectMcpClient, ProjectMcpConnection } from "./ProjectMcpConnection.ts";
import * as ProjectMcpProxyHttpServer from "./ProjectMcpProxyHttpServer.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";

const serverId = McpServerId.make("server/with-untrusted-path");
const transport = {
  type: "streamable-http" as const,
  url: "https://upstream.example.test/rpc",
  headers: [],
  authorization: { type: "none" as const },
};

const connection = (close: () => Promise<void>): ProjectMcpConnection => ({
  client: {
    connect: vi.fn(),
    close,
    ping: vi.fn(async () => ({})),
  },
  transport,
  protocolEra: "modern",
  negotiatedProtocolVersion: "2026-07-28",
  discoverResult: {
    protocolVersion: "2026-07-28",
    supportedVersions: ["2026-07-28"],
    capabilities: {},
    serverInfo: { name: "fixture", version: "1" },
  },
  close,
});

const server = {
  id: serverId,
  name: "Untrusted path",
  transport,
};

const makeRegistry = (connect: ProjectMcpProxyRegistry.ProjectMcpProxyConnect) =>
  ProjectMcpProxyRegistry.__testing.make({
    endpointBase: "http://127.0.0.1:43123/mcp",
    connect,
  });

const sessionScope: McpInvocationContext.McpInvocationScope = {
  environmentId: "environment-1" as never,
  threadId: ThreadId.make("thread-a"),
  providerSessionId: "provider-a",
  providerInstanceId: "codex" as never,
  capabilities: new Set(["project"]),
  issuedAt: 1,
};

const clientForFixture = (): ProjectMcpClient => ({
  connect: async () => undefined,
  close: async () => undefined,
  listTools: async () => ({
    tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
  }),
  callTool: async (params) => ({
    content: [
      {
        type: "text",
        text: String((params?.arguments as Record<string, unknown> | undefined)?.message ?? ""),
      },
    ],
  }),
  ping: async () => ({}),
  getProtocolEra: () => "modern",
  getNegotiatedProtocolVersion: () => "2026-07-28",
  getDiscoverResult: () => ({
    protocolVersion: "2026-07-28",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1" },
  }),
});

const fixtureSessionRegistry = (): McpSessionRegistry.McpSessionRegistryShape => ({
  issue: vi.fn(),
  resolve: () => Effect.succeed(sessionScope),
  touch: vi.fn(),
  revokeProviderSession: vi.fn(),
  revokeThread: vi.fn(),
  revokeAll: Effect.void,
});

it.effect("issues opaque immutable endpoints and isolates sessions", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(async () => connection(async () => undefined));
    const first = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });
    const second = yield* registry.registerSession({
      providerSessionId: "provider-b",
      threadId: ThreadId.make("thread-b"),
      servers: [server],
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.endpointHandle).not.toBe(second[0]!.endpointHandle);
    expect(first[0]!.endpoint.pathname).toBe(`/mcp/project/${first[0]!.endpointHandle}`);
    expect(first[0]!.endpoint.pathname).not.toContain(String(serverId));
    expect(first[0]).not.toHaveProperty("transport");
    expect(first[0]).not.toHaveProperty("url");

    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]!.endpoint)).toBe(true);
    const resolved = yield* registry.resolve("provider-a", first[0]!.endpointHandle);
    expect(resolved?.server.id).toBe(serverId);
  }),
);

it.effect("revokes sessions registered after the registry was created", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(async () => connection(async () => undefined));
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });

    yield* registry.revokeAll;

    expect(yield* registry.resolve("provider-a", issued!.endpointHandle)).toBeUndefined();
  }),
);

it.effect("serializes concurrent first acquisition and closes exactly once", () =>
  Effect.gen(function* () {
    let opens = 0;
    let releaseCount = 0;
    let resolveOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const registry = yield* makeRegistry(async () => {
      opens += 1;
      await openGate;
      return connection(async () => {
        releaseCount += 1;
      });
    });
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });
    const first = yield* Effect.forkChild(
      registry.handle("provider-a", issued!.endpointHandle, new Request(String(issued!.endpoint))),
      { startImmediately: true },
    );
    const second = yield* Effect.forkChild(
      registry.handle("provider-a", issued!.endpointHandle, new Request(String(issued!.endpoint))),
      { startImmediately: true },
    );

    yield* Effect.promise(() => Promise.resolve());
    expect(opens).toBe(1);
    resolveOpen!();
    yield* Effect.all([Fiber.join(first), Fiber.join(second)]);

    yield* registry.revokeProviderSession("provider-a");
    yield* registry.revokeProviderSession("provider-a");
    expect(releaseCount).toBe(1);
  }),
);

it.effect("does not let another provider session use an endpoint", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(async () => connection(async () => undefined));
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });

    const error = yield* Effect.flip(
      registry.handle("provider-b", issued!.endpointHandle, new Request(String(issued!.endpoint))),
    );
    expect(error._tag).toBe("ProjectMcpProxyUnauthorizedError");
  }),
);

it.effect("speaks the modern MCP protocol through the SDK client and HTTP route", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(async () => ({
      client: clientForFixture(),
      transport,
      protocolEra: "modern",
      negotiatedProtocolVersion: "2026-07-28",
      discoverResult: {
        protocolVersion: "2026-07-28",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      },
      close: async () => undefined,
    }));
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });
    const sessions = fixtureSessionRegistry();
    const fetchFn: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      const effectRequest = HttpServerRequest.fromWeb(request);
      const response = await Effect.runPromise(
        ProjectMcpProxyHttpServer.handleProjectMcpProxyRequest(effectRequest).pipe(
          Effect.provideService(McpSessionRegistry.McpSessionRegistry, sessions),
          Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, registry),
        ),
      );
      const result = HttpServerResponse.toWeb(response);
      return result;
    };
    const client = new Client({ name: "sdk-fixture", version: "1" });
    const sdkTransport = new StreamableHTTPClientTransport(issued!.endpoint, {
      authProvider: { token: async () => "provider-token" },
      fetch: fetchFn,
    });

    yield* Effect.promise(() => client.connect(sdkTransport));
    const tools = yield* Effect.promise(() => client.listTools());
    const result = yield* Effect.promise(() =>
      client.callTool({ name: "echo", arguments: { message: "through-proxy" } }),
    );
    yield* Effect.promise(() => client.close());

    expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(result.content).toEqual([{ type: "text", text: "through-proxy" }]);
  }),
);

it.effect("keeps modern subscription notifications alive across HTTP requests", () =>
  Effect.gen(function* () {
    let upstreamToolsChanged: ((notification: unknown) => void | Promise<void>) | undefined;
    const discoverResult = {
      protocolVersion: "2026-07-28",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: true }, subscriptions: {} },
      serverInfo: { name: "subscription-fixture", version: "1" },
    };
    const upstream = {
      ...clientForFixture(),
      getDiscoverResult: () => discoverResult,
      setNotificationHandler: ((method: string, handler: unknown) => {
        if (method === "notifications/tools/list_changed") {
          upstreamToolsChanged = handler as typeof upstreamToolsChanged;
        }
      }) as NonNullable<ProjectMcpClient["setNotificationHandler"]>,
    } satisfies ProjectMcpClient;
    const registry = yield* makeRegistry(async () => ({
      client: upstream,
      transport,
      protocolEra: "modern" as const,
      negotiatedProtocolVersion: "2026-07-28",
      discoverResult,
      serverCapabilities: discoverResult.capabilities,
      serverVersion: discoverResult.serverInfo,
      close: async () => undefined,
    }));
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });
    const modernRequest = (id: string, method: string, params: Record<string, unknown>) =>
      new Request(String(issued!.endpoint), {
        method: "POST",
        headers: {
          authorization: "Bearer provider-token",
          "content-type": "application/json",
          "mcp-method": method,
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "subscription-fixture",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
    const listenResponse = yield* registry.handle(
      "provider-a",
      issued!.endpointHandle,
      modernRequest("listen", "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      }),
    );
    if (listenResponse.status !== 200) {
      const body = yield* Effect.promise(() => listenResponse.text());
      throw new Error(`Unexpected subscription response: ${listenResponse.status} ${body}`);
    }
    expect(listenResponse.status).toBe(200);
    const reader = listenResponse.body?.getReader();
    if (!reader) throw new Error("The subscription response did not include an SSE stream.");
    const acknowledged = yield* Effect.promise(() => reader.read());
    const acknowledgedText = new TextDecoder().decode(acknowledged.value);
    expect(acknowledgedText).toContain("notifications/subscriptions/acknowledged");

    const secondRequest = yield* registry.handle(
      "provider-a",
      issued!.endpointHandle,
      modernRequest("list", "tools/list", {}),
    );
    expect(secondRequest.status).toBe(200);
    yield* Effect.promise(() => secondRequest.arrayBuffer());

    if (upstreamToolsChanged === undefined) throw new Error("upstream handler was not registered");
    yield* Effect.promise(async () => {
      await upstreamToolsChanged!({});
    });
    const notification = yield* Effect.promise(() => reader.read());
    const notificationText = new TextDecoder().decode(notification.value);
    expect(notificationText).toContain("notifications/tools/list_changed");
    yield* Effect.promise(() => reader.cancel());
    yield* registry.revokeProviderSession("provider-a");
  }),
);

it.effect("accepts a legacy streamable HTTP client through a stateful session", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(async () => ({
      client: {
        ...clientForFixture(),
        getProtocolEra: () => "legacy" as const,
        getNegotiatedProtocolVersion: () => "2025-11-25",
        getDiscoverResult: () => undefined,
        getServerCapabilities: () => ({ tools: {} }),
        getServerVersion: () => ({ name: "legacy-fixture", version: "1" }),
      },
      transport,
      discoverResult: undefined,
      protocolEra: "legacy" as const,
      negotiatedProtocolVersion: "2025-11-25",
      serverCapabilities: { tools: {} },
      serverVersion: { name: "legacy-fixture", version: "1" },
      close: async () => undefined,
    }));
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });
    const sessions = fixtureSessionRegistry();
    const fetchFn: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      const effectRequest = HttpServerRequest.fromWeb(request);
      const response = await Effect.runPromise(
        ProjectMcpProxyHttpServer.handleProjectMcpProxyRequest(effectRequest).pipe(
          Effect.provideService(McpSessionRegistry.McpSessionRegistry, sessions),
          Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, registry),
        ),
      );
      return HttpServerResponse.toWeb(response);
    };
    const client = new Client(
      { name: "legacy-sdk-fixture", version: "1" },
      { versionNegotiation: { mode: "legacy" } },
    );
    const sdkTransport = new StreamableHTTPClientTransport(issued!.endpoint, {
      authProvider: { token: async () => "provider-token" },
      fetch: fetchFn,
    });

    yield* Effect.promise(() => client.connect(sdkTransport));
    const tools = yield* Effect.promise(() => client.listTools());
    yield* Effect.promise(() => client.close());

    expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);
  }),
);

it.effect("bridges legacy upstream server requests to a modern downstream client", () =>
  Effect.gen(function* () {
    const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();
    const upstreamServer = new Server({ name: "legacy-upstream", version: "1" });
    const roots = { roots: [{ uri: "file:///workspace", name: "workspace" }] };
    upstreamServer.registerCapabilities({ tools: {} });
    upstreamServer.setRequestHandler("tools/list", () => ({
      tools: [
        { name: "needs-roots", description: "Needs roots", inputSchema: { type: "object" } },
        {
          name: "needs-sampling",
          description: "Needs sampling",
          inputSchema: { type: "object" },
        },
        {
          name: "needs-elicitation",
          description: "Needs elicitation",
          inputSchema: { type: "object" },
        },
      ],
    }));
    upstreamServer.setRequestHandler("tools/call", async (request, context) => {
      const method =
        request.params.name === "needs-roots"
          ? ("roots/list" as const)
          : request.params.name === "needs-sampling"
            ? ("sampling/createMessage" as const)
            : ("elicitation/create" as const);
      const result =
        method === "roots/list"
          ? await context.mcpReq.send({ method })
          : method === "sampling/createMessage"
            ? await context.mcpReq.send({
                method,
                params: {
                  messages: [{ role: "user", content: { type: "text", text: "Continue?" } }],
                  maxTokens: 16,
                },
              })
            : await context.mcpReq.send({
                method,
                params: {
                  mode: "form",
                  message: "Continue?",
                  requestedSchema: {
                    type: "object",
                    properties: { approved: { type: "boolean" } },
                    required: ["approved"],
                  },
                },
              });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };
    });
    const upstreamClient = new Client(
      { name: "legacy-upstream-client", version: "1" },
      {
        capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
        versionNegotiation: { mode: "legacy" },
      },
    );
    yield* Effect.promise(() => upstreamServer.connect(upstreamServerTransport));
    yield* Effect.promise(() => upstreamClient.connect(upstreamClientTransport));

    const registry = yield* makeRegistry(async () => ({
      client: upstreamClient as unknown as ProjectMcpClient,
      transport,
      protocolEra: "legacy" as const,
      negotiatedProtocolVersion: "2025-11-25",
      discoverResult: undefined,
      serverCapabilities: { tools: {} },
      serverVersion: { name: "legacy-upstream", version: "1" },
      close: async () => {
        await Promise.allSettled([upstreamClient.close(), upstreamServer.close()]);
      },
    }));
    const [issued] = yield* registry.registerSession({
      providerSessionId: "provider-a",
      threadId: ThreadId.make("thread-a"),
      servers: [server],
    });
    const sessions = fixtureSessionRegistry();
    const fetchFn: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      const effectRequest = HttpServerRequest.fromWeb(request);
      const response = await Effect.runPromise(
        ProjectMcpProxyHttpServer.handleProjectMcpProxyRequest(effectRequest).pipe(
          Effect.provideService(McpSessionRegistry.McpSessionRegistry, sessions),
          Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, registry),
        ),
      );
      return HttpServerResponse.toWeb(response);
    };
    const downstreamClient = new Client(
      { name: "modern-downstream-client", version: "1" },
      {
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
          elicitation: { form: {} },
        },
      },
    );
    downstreamClient.setRequestHandler("roots/list", async () => roots);
    downstreamClient.setRequestHandler("sampling/createMessage", async () => ({
      model: "fixture",
      role: "assistant",
      content: { type: "text", text: "sampled" },
    }));
    downstreamClient.setRequestHandler("elicitation/create", async () => ({
      action: "accept",
      content: { approved: true },
    }));
    const downstreamTransport = new StreamableHTTPClientTransport(issued!.endpoint, {
      authProvider: { token: async () => "provider-token" },
      fetch: fetchFn,
    });

    yield* Effect.promise(() => downstreamClient.connect(downstreamTransport));
    const results = [];
    for (const name of ["needs-roots", "needs-sampling", "needs-elicitation"] as const) {
      results.push(yield* Effect.promise(() => downstreamClient.callTool({ name, arguments: {} })));
    }
    yield* Effect.promise(() => downstreamClient.close());
    yield* registry.revokeProviderSession("provider-a");

    expect(results.map((result) => result.isError)).toEqual([false, false, false]);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    expect(results[0]?.content).toEqual([{ type: "text", text: JSON.stringify(roots) }]);
    expect(results[1]?.content).toEqual([
      {
        type: "text",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        text: JSON.stringify({
          model: "fixture",
          role: "assistant",
          content: { type: "text", text: "sampled" },
        }),
      },
    ]);
    expect(results[2]?.content).toEqual([
      {
        type: "text",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        text: JSON.stringify({ action: "accept", content: { approved: true } }),
      },
    ]);
  }),
);
