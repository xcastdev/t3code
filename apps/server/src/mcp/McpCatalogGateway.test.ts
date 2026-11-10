// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pins the alias hash independently of the implementation.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { AssistantNativeResources } from "../assistants/AssistantNativeResources.ts";
import { expect, it } from "@effect/vitest";
import {
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  PLUGIN_LIMITS,
  PluginId,
  PluginRequestError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PluginInstallRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  __testing,
  PLUGIN_MUTATION_REFUSED_MESSAGE,
  type RegisterCatalogSessionInput,
} from "./McpCatalogGateway.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { PluginService, type PluginAgentCatalogEntry } from "../plugins/PluginService.ts";
import { McpSessionRegistry, type McpNativeRuntimeBinding } from "./McpSessionRegistry.ts";
import { ProjectMcpProxyRegistry, ProjectMcpConnectionError } from "./ProjectMcpProxyRegistry.ts";
import * as McpCatalogAliasStoreModule from "./McpCatalogAliasStore.ts";
import { McpCatalogAliasStore, McpCatalogAliasStoreError } from "./McpCatalogAliasStore.ts";
import type { CatalogAliases } from "./ProjectMcpBroker.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const memoryAliasStore = () => {
  const rows = new Map<McpCatalogSessionId, CatalogAliases>();
  return McpCatalogAliasStore.of({
    read: (id) => Effect.succeed(rows.get(id)),
    write: (id, aliases) => Effect.sync(() => void rows.set(id, aliases)),
  });
};

const setupWith = Effect.fn("testMcpCatalogGateway.setup")(function* (
  aliasStore: McpCatalogAliasStore["Service"],
) {
  const binding: McpNativeRuntimeBinding = {
    providerSessionId: "issued-mcp-identity",
    threadId: ThreadId.make("thread"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeId: "native-1",
  };
  let active: McpNativeRuntimeBinding | undefined = binding;
  let listener: ((identity: string) => Effect.Effect<void>) | undefined;
  const registry = McpSessionRegistry.of({
    bindNativeRuntime: (value) =>
      Effect.sync(() => {
        active = value;
      }),
    resolveNativeRuntime: (identity) =>
      Effect.succeed(active?.providerSessionId === identity ? active : undefined),
    onRevoke: (value) =>
      Effect.sync(() => {
        listener = value;
        return () => {
          listener = undefined;
        };
      }),
    issue: () => Effect.die("unused"),
    resolve: () => Effect.sync(() => undefined),
    touch: () => Effect.void,
    revokeProviderSession: (identity) =>
      Effect.gen(function* () {
        active = undefined;
        if (listener) yield* listener(identity);
      }),
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  });
  let connect: Parameters<typeof ProjectMcpProxyRegistry.of>[0]["connect"] = () =>
    Effect.fail(new ProjectMcpConnectionError());
  const proxy = ProjectMcpProxyRegistry.of({
    connect: (entry) => Effect.suspend(() => connect(entry)),
  });
  let allowedTools: ReadonlyArray<string> | undefined;
  // Absent by default so catalog-only cases keep their exact tool lists.
  const plugins = {
    echo: "absent" as "absent" | "enabled" | "disabled",
    // Disabled after the catalog read: agentCatalog still lists it, callOperation refuses.
    disabledMidCall: false,
    calls: [] as Array<{ operation: string; input: unknown; context?: unknown }>,
    result: undefined as unknown,
    call: undefined as undefined | Effect.Effect<unknown>,
    threadShell: "present" as "present" | "missing",
  };
  let threadModes: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "interactionMode"> = {
    runtimeMode: "full-access",
    interactionMode: "default",
  };
  const pluginService = {
    agentCatalog: Effect.sync(() => (plugins.echo === "enabled" ? [echoCatalogEntry] : [])),
    list: Effect.sync(() => ({
      installed: (plugins.echo === "absent"
        ? []
        : [
            {
              pluginId: echoCatalogEntry.pluginId,
              name: "Echo",
              enabled: plugins.echo === "enabled" && !plugins.disabledMidCall,
            },
          ]) as unknown as ReadonlyArray<PluginInstallRecord>,
      retainedData: [],
    })),
    callOperation: (request: { operation: string; input: unknown; context: unknown }) =>
      plugins.echo === "enabled" && !plugins.disabledMidCall
        ? (plugins.call ??
          Effect.sync(() => {
            plugins.calls.push({
              operation: request.operation,
              input: request.input,
              context: request.context,
            });
            return plugins.result ?? { echoed: request.operation };
          }))
        : Effect.fail(new PluginRequestError({ reason: "disabled" })),
  } as unknown as PluginService["Service"];
  const projections = {
    getThreadShell: (threadId: ThreadId) =>
      Effect.sync(() => {
        expect(threadId).toBe(binding.threadId);
        return plugins.threadShell === "missing"
          ? null
          : ({
              ...threadModes,
              id: threadId,
              projectId: ProjectId.make("project"),
              lineage: {
                parentThreadId: ThreadId.make("parent"),
                relationshipToParent: "subagent",
                rootThreadId: ThreadId.make("root"),
              },
              deletedAt: null,
            } as OrchestrationV2ThreadShell);
      }),
  } as unknown as ProjectionStoreV2["Service"];
  const makeGateway = __testing.make.pipe(
    Effect.provideService(AssistantNativeResources, {
      tools: () => Effect.sync(() => allowedTools),
    }),
    Effect.provideService(PluginService, pluginService),
    Effect.provideService(ProjectionStoreV2, projections),
    Effect.provideService(McpSessionRegistry, registry),
    Effect.provideService(ProjectMcpProxyRegistry, proxy),
    Effect.provideService(McpCatalogAliasStore, aliasStore),
  );
  const gateway = yield* makeGateway;
  const input: RegisterCatalogSessionInput = {
    ...binding,
    catalogSessionId: McpCatalogSessionId.make("catalog"),
    revision: 1,
    entries: [],
  };
  return {
    gateway,
    makeGateway,
    input,
    setAllowedTools: (value: ReadonlyArray<string> | undefined) => {
      allowedTools = value;
    },
    registry,
    setConnect: (value: typeof connect) => {
      connect = value;
    },
    plugins,
    setThreadModes: (value: typeof threadModes) => {
      threadModes = value;
    },
  };
});
const setup = Effect.suspend(() => setupWith(memoryAliasStore()));

const echoCatalogEntry: PluginAgentCatalogEntry = {
  pluginId: PluginId.make("echo"),
  name: "Echo",
  operations: [
    {
      name: "ping",
      title: "Ping",
      description: "Answers without changing state.",
      inputSchema: { type: "object" },
      mutates: false,
      agent: true,
    },
    {
      name: "pong",
      title: "Pong",
      description: "Changes state.",
      inputSchema: { type: "object" },
      mutates: true,
      agent: true,
    },
    {
      name: "log",
      title: "Log",
      description: "Panel only.",
      inputSchema: { type: "object" },
      mutates: false,
      agent: false,
    },
  ],
  resources: [{ name: "status", title: "Echo status", operation: "ping" }],
};

const encodePacket = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const rpc = Effect.fn("testMcpCatalogGateway.rpc")(function* (
  gateway: Effect.Success<typeof setup>["gateway"],
  input: RegisterCatalogSessionInput,
  method: string,
  params: unknown,
) {
  const response = yield* gateway.handle(
    input.providerSessionId,
    input.providerSessionId,
    new Request(`http://localhost/mcp/catalog/${input.providerSessionId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: encodePacket({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return yield* Effect.promise(() => response.json());
});

it.effect("failed complete staging retains the previous applied catalog", () =>
  Effect.gen(function* () {
    const memory = memoryAliasStore();
    let aliasWriteFails = false;
    const { gateway, input, setConnect } = yield* setupWith({
      ...memory,
      write: (id, aliases) =>
        aliasWriteFails
          ? Effect.fail(new McpCatalogAliasStoreError({ cause: "disk full" }))
          : memory.write(id, aliases),
    });
    yield* gateway.applyCatalogRevision(input);
    const weather = {
      ...input,
      revision: 2,
      entries: [
        {
          logicalServerId: McpServerId.make("weather"),
          transportDefinitionId: McpDefinitionId.make("definition"),
          name: "Weather",
          providerInstanceId: input.providerInstanceId,
          scope: "project" as const,
          scopeId: "project",
          transport: { type: "stdio" as const, command: "unused", args: [], env: [] },
        },
      ],
    };
    const failure = yield* gateway.applyCatalogRevision(weather).pipe(Effect.flip);
    expect(failure.message).toBe("MCP catalog apply failed.");
    expect((yield* gateway.resolveCatalogSession(input.catalogSessionId))?.revision).toBe(1);

    // A connected revision whose aliases cannot be stored must not install or leak its upstreams.
    aliasWriteFails = true;
    const closed = yield* Deferred.make<void>();
    setConnect((entry) =>
      Effect.acquireRelease(
        Effect.succeed({ entry, client: new Client({ name: "fixture", version: "1" }) }),
        () => Deferred.succeed(closed, undefined),
      ),
    );
    const writeFailure = yield* gateway.applyCatalogRevision(weather).pipe(Effect.flip);
    expect(writeFailure.message).toBe("MCP catalog apply failed.");
    yield* Deferred.await(closed);
    expect((yield* gateway.resolveCatalogSession(input.catalogSessionId))?.revision).toBe(1);
  }),
);
it.effect("requires exact issued identity and revokes endpoint with native credential", () =>
  Effect.gen(function* () {
    const { gateway, input, registry } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    const request = () =>
      new Request(`http://localhost/mcp/catalog/${input.providerSessionId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    expect((yield* gateway.handle("wrong", input.providerSessionId, request())).status).toBe(401);
    expect((yield* gateway.handle(input.providerSessionId, "wrong", request())).status).toBe(401);
    const response = yield* gateway.handle(
      input.providerSessionId,
      input.providerSessionId,
      request(),
    );
    const payload = yield* Effect.promise(() => response.json());
    expect(payload).toMatchObject({ result: { tools: [] } });
    yield* registry.revokeProviderSession(input.providerSessionId);
    expect(yield* gateway.resolveCatalogSession(input.catalogSessionId)).toBeUndefined();
    expect(
      (yield* gateway.handle(input.providerSessionId, input.providerSessionId, request())).status,
    ).toBe(401);
  }),
);
it.effect("rejects V2 logical session identity and stale native generation", () =>
  Effect.gen(function* () {
    const { gateway, input } = yield* setup;
    expect(
      (yield* gateway
        .applyCatalogRevision({ ...input, providerSessionId: "v2-session" })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure");
    expect(
      (yield* gateway.applyCatalogRevision({ ...input, runtimeId: "native-old" }).pipe(Effect.exit))
        ._tag,
    ).toBe("Failure");
  }),
);

it.effect(
  "revocation during an upstream handshake cannot resurrect a catalog or retain its lease",
  () =>
    Effect.gen(function* () {
      const { gateway, input, registry, setConnect } = yield* setup;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let closed = false;
      setConnect((entry) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          return { entry, client: new Client({ name: "fixture", version: "1" }) };
        }),
      );
      const apply = yield* gateway
        .applyCatalogRevision({
          ...input,
          entries: [
            {
              logicalServerId: McpServerId.make("weather"),
              transportDefinitionId: McpDefinitionId.make("definition"),
              name: "Weather",
              providerInstanceId: input.providerInstanceId,
              scope: "project",
              scopeId: "project",
              transport: { type: "stdio", command: "unused", args: [], env: [] },
            },
          ],
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* registry.revokeProviderSession(input.providerSessionId);
      yield* Deferred.succeed(resume, undefined);
      expect((yield* Fiber.join(apply))._tag).toBe("Failure");
      expect(closed).toBe(true);
      expect(yield* gateway.resolveCatalogSession(input.catalogSessionId)).toBeUndefined();
    }),
);

it.effect(
  "closes upstream clients in parallel and retains each own lease until its client stops",
  () =>
    Effect.gen(function* () {
      const { gateway, input, registry, setConnect } = yield* setup;
      const started = yield* Queue.unbounded<string>();
      const resume = yield* Deferred.make<void>();
      const released = new Set<string>();
      setConnect((entry) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released.add(entry.logicalServerId);
            }),
          );
          yield* Effect.addFinalizer(() =>
            Queue.offer(started, entry.logicalServerId).pipe(
              Effect.andThen(Deferred.await(resume)),
            ),
          );
          return { entry, client: new Client({ name: "fixture", version: "1" }) };
        }),
      );
      const entries = ["one", "two", "three"].map((id) => ({
        logicalServerId: McpServerId.make(id),
        transportDefinitionId: McpDefinitionId.make(id),
        name: id,
        providerInstanceId: input.providerInstanceId,
        scope: "project" as const,
        scopeId: "project",
        transport: { type: "stdio" as const, command: "unused", args: [], env: [] },
      }));
      yield* gateway.applyCatalogRevision({ ...input, entries });
      const revoking = yield* registry
        .revokeProviderSession(input.providerSessionId)
        .pipe(Effect.forkChild);
      const closing = [
        yield* Queue.take(started),
        yield* Queue.take(started),
        yield* Queue.take(started),
      ];
      expect(new Set(closing)).toEqual(new Set(["one", "two", "three"]));
      expect(released.size).toBe(0);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(revoking);
      expect(released.size).toBe(3);
    }),
);

it.effect("forwards every prompt and resource template page through the real MCP protocol", () =>
  Effect.gen(function* () {
    const { gateway, input, setConnect } = yield* setup;
    setConnect((entry) =>
      Effect.gen(function* () {
        const [left, right] = InMemoryTransport.createLinkedPair();
        const server = new Server(
          { name: "fixture", version: "1" },
          { capabilities: { resources: {}, prompts: {} } },
        );
        server.setRequestHandler(ListPromptsRequestSchema, (request) => ({
          prompts: [{ name: request.params?.cursor ? "second" : "first" }],
          ...(request.params?.cursor ? {} : { nextCursor: "next" }),
        }));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => ({
          resourceTemplates: [
            {
              name: request.params?.cursor ? "second" : "first",
              uriTemplate: request.params?.cursor ? "file:///{+path}" : "file:///{path}",
            },
          ],
          ...(request.params?.cursor ? {} : { nextCursor: "next" }),
        }));
        const client = new Client({ name: "fixture", version: "1" });
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await server.connect(right);
            await client.connect(left);
          }),
          () =>
            Effect.promise(async () => {
              await client.close();
              await server.close();
            }),
        );
        return { entry, client };
      }),
    );
    yield* gateway.applyCatalogRevision({
      ...input,
      entries: [
        {
          logicalServerId: McpServerId.make("server"),
          transportDefinitionId: McpDefinitionId.make("definition"),
          name: "Server",
          providerInstanceId: input.providerInstanceId,
          scope: "project",
          scopeId: "project",
          transport: { type: "stdio", command: "unused", args: [], env: [] },
        },
      ],
    });
    for (const method of ["prompts/list", "resources/templates/list"]) {
      const response = yield* gateway.handle(
        input.providerSessionId,
        input.providerSessionId,
        new Request(`http://localhost/mcp/catalog/${input.providerSessionId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
        }),
      );
      const result = yield* Effect.promise(() => response.json());
      const prefix = "server__";
      expect(result).toMatchObject({
        result: {
          [method === "prompts/list" ? "prompts" : "resourceTemplates"]: [
            { name: prefix + "first" },
            { name: prefix + "second" },
          ],
        },
      });
    }
  }),
);

it.effect.each(["tools/list", "resources/list", "resources/templates/list", "prompts/list"])(
  "bounds empty unique-cursor pages for %s without returning a partial catalog",
  (method) =>
    Effect.gen(function* () {
      const { gateway, input, setConnect } = yield* setup;
      let requests = 0;
      setConnect((entry) =>
        Effect.gen(function* () {
          const [left, right] = InMemoryTransport.createLinkedPair();
          const server = new Server(
            { name: "fixture", version: "1" },
            { capabilities: { tools: {}, resources: {}, prompts: {} } },
          );
          const next = () => String(++requests);
          server.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: [],
            nextCursor: next(),
          }));
          server.setRequestHandler(ListResourcesRequestSchema, () => ({
            resources: [],
            nextCursor: next(),
          }));
          server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
            resourceTemplates: [],
            nextCursor: next(),
          }));
          server.setRequestHandler(ListPromptsRequestSchema, () => ({
            prompts: [],
            nextCursor: next(),
          }));
          const client = new Client({ name: "fixture", version: "1" });
          yield* Effect.acquireRelease(
            Effect.promise(async () => {
              await server.connect(right);
              await client.connect(left);
            }),
            () =>
              Effect.promise(async () => {
                await client.close();
                await server.close();
              }),
          );
          return { entry, client };
        }),
      );
      yield* gateway.applyCatalogRevision({
        ...input,
        entries: [
          {
            logicalServerId: McpServerId.make("server"),
            transportDefinitionId: McpDefinitionId.make("definition"),
            name: "Server",
            providerInstanceId: input.providerInstanceId,
            scope: "project",
            scopeId: "project",
            transport: { type: "stdio", command: "unused", args: [], env: [] },
          },
        ],
      });
      const response = yield* gateway.handle(
        input.providerSessionId,
        input.providerSessionId,
        new Request(`http://localhost/mcp/catalog/${input.providerSessionId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
        }),
      );
      const result = yield* Effect.promise(() => response.json());
      expect(result).toMatchObject({
        error: { message: "MCP upstream discovery limit exceeded." },
      });
      expect(result).not.toHaveProperty("result");
      expect(requests).toBe(100);
    }),
);

it.effect("exposes readable server aliases and routes each call back to its server", () =>
  Effect.gen(function* () {
    const { gateway, makeGateway, input, setConnect } = yield* setupWith(
      yield* McpCatalogAliasStore,
    );
    setConnect((entry) =>
      Effect.gen(function* () {
        const [left, right] = InMemoryTransport.createLinkedPair();
        const upstream = new Server(
          { name: "fixture", version: "1" },
          { capabilities: { tools: {} } },
        );
        upstream.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [
            { name: "traffic_search", inputSchema: { type: "object" } },
            { name: "a__b", inputSchema: { type: "object" } },
          ],
        }));
        upstream.setRequestHandler(CallToolRequestSchema, (request) => ({
          content: [{ type: "text", text: `${entry.logicalServerId}:${request.params.name}` }],
        }));
        const client = new Client({ name: "fixture", version: "1" });
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await upstream.connect(right);
            await client.connect(left);
          }),
          () =>
            Effect.promise(async () => {
              await client.close();
              await upstream.close();
            }),
        );
        return { entry, client };
      }),
    );
    const entry = (id: string, name: string) => ({
      logicalServerId: McpServerId.make(id),
      transportDefinitionId: McpDefinitionId.make(id),
      name,
      providerInstanceId: input.providerInstanceId,
      scope: "project" as const,
      scopeId: "project",
      transport: { type: "stdio" as const, command: "unused", args: [], env: [] },
    });
    yield* gateway.applyCatalogRevision({
      ...input,
      entries: [entry("b", "browser-mcp"), entry("a", "Browser MCP"), entry("c", "Docs")],
    });
    const listed = (yield* rpc(gateway, input, "tools/list", {})) as {
      result: { tools: ReadonlyArray<{ name: string }> };
    };
    const hashed = (base: string, id: string) =>
      `${base}_${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 6)}`;
    const [a, b] = [hashed("browser_mcp", "a"), hashed("browser_mcp", "b")];
    expect(listed.result.tools.map((tool) => tool.name).toSorted()).toEqual(
      [
        `${a}__a__b`,
        `${a}__traffic_search`,
        `${b}__a__b`,
        `${b}__traffic_search`,
        "docs__a__b",
        "docs__traffic_search",
      ].toSorted(),
    );
    for (const [name, routed] of [
      [`${a}__traffic_search`, "a:traffic_search"],
      [`${b}__traffic_search`, "b:traffic_search"],
      [`${b}__a__b`, "b:a__b"],
      ["docs__a__b", "c:a__b"],
    ])
      expect(yield* rpc(gateway, input, "tools/call", { name, arguments: {} })).toMatchObject({
        result: { content: [{ text: routed }] },
      });
    expect(
      yield* rpc(gateway, input, "tools/call", {
        name: "browser_mcp__traffic_search",
        arguments: {},
      }),
    ).toMatchObject({ error: { message: "Unknown MCP catalog item." } });

    // After a restart the provider may still replay `docs__…`, so it must not reach a new server.
    const restarted = yield* makeGateway;
    yield* restarted.applyCatalogRevision({
      ...input,
      revision: 2,
      entries: [entry("c", "Old docs"), entry("d", "Docs")],
    });
    for (const [name, routed] of [
      ["old_docs__a__b", "c:a__b"],
      [`${hashed("docs", "d")}__a__b`, "d:a__b"],
    ])
      expect(yield* rpc(restarted, input, "tools/call", { name, arguments: {} })).toMatchObject({
        result: { content: [{ text: routed }] },
      });
    expect(
      yield* rpc(restarted, input, "tools/call", { name: "docs__a__b", arguments: {} }),
    ).toMatchObject({ error: { message: "Unknown MCP catalog item." } });

    // An unreadable stored row is treated as missing instead of failing every later apply.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE t3_workflow_v2_mcp_catalog_aliases SET aliases_json='{"byServer":1}'`;
    const recovered = yield* makeGateway;
    yield* recovered.applyCatalogRevision({ ...input, revision: 3, entries: [entry("d", "Docs")] });
    expect(
      yield* rpc(recovered, input, "tools/call", { name: "docs__a__b", arguments: {} }),
    ).toMatchObject({ result: { content: [{ text: "d:a__b" }] } });
  }).pipe(
    Effect.provide(McpCatalogAliasStoreModule.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
  ),
);

const encodeAssistantMcpPacket = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect(
  "assistant tool selection filters discovery and revocation blocks the next native call",
  () =>
    Effect.gen(function* () {
      const { gateway, input, setConnect, setAllowedTools } = yield* setup;
      let calls = 0;
      setConnect((entry) =>
        Effect.gen(function* () {
          const [left, right] = InMemoryTransport.createLinkedPair();
          const upstream = new Server(
            { name: "fixture", version: "1" },
            { capabilities: { tools: {} } },
          );
          upstream.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: [
              { name: "read", inputSchema: { type: "object" } },
              { name: "write", inputSchema: { type: "object" } },
            ],
          }));
          upstream.setRequestHandler(CallToolRequestSchema, () => {
            calls++;
            return { content: [{ type: "text", text: "ok" }] };
          });
          const client = new Client({ name: "fixture", version: "1" });
          yield* Effect.acquireRelease(
            Effect.promise(async () => {
              await upstream.connect(right);
              await client.connect(left);
            }),
            () =>
              Effect.promise(async () => {
                await client.close();
                await upstream.close();
              }),
          );
          return { entry, client };
        }),
      );
      const logicalServerId = McpServerId.make("selected");
      yield* gateway.applyCatalogRevision({
        ...input,
        entries: [
          {
            logicalServerId,
            transportDefinitionId: McpDefinitionId.make("definition"),
            name: "Selected",
            providerInstanceId: input.providerInstanceId,
            scope: "project",
            scopeId: "project",
            transport: { type: "stdio", command: "unused", args: [], env: [] },
          },
        ],
      });
      setAllowedTools(["definition:read"]);
      const request = Effect.fn("testAssistantNativeTools.request")(function* (
        method: string,
        params: unknown,
      ) {
        const response = yield* gateway.handle(
          input.providerSessionId,
          input.providerSessionId,
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: encodeAssistantMcpPacket({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        );
        return yield* Effect.promise(() => response.json());
      });
      expect(yield* request("tools/list", {})).toMatchObject({
        result: { tools: [{ name: "selected__read" }] },
      });
      yield* request("tools/call", {
        name: "selected__write",
        arguments: {},
      });
      expect(calls).toBe(0);
      yield* request("tools/call", { name: "selected__read", arguments: {} });
      expect(calls).toBe(1);
      setAllowedTools([]);
      yield* request("tools/call", { name: "selected__read", arguments: {} });
      expect(calls).toBe(1);
    }),
);

it.effect("lists plugin agent tools with read-only and destructive hints", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    expect(yield* rpc(gateway, input, "tools/list", {})).toMatchObject({
      result: {
        tools: [
          {
            name: "plugin_echo__ping",
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: "plugin_echo__pong",
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      },
    });
  }),
);

it.effect("omits non-agent operations and refuses calling them by name", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    const listed = (yield* rpc(gateway, input, "tools/list", {})) as {
      result: { tools: ReadonlyArray<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("plugin_echo__log");
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__log", arguments: {} }),
    ).toMatchObject({ error: { message: "This plugin has no such operation." } });
    expect(plugins.calls).toEqual([]);
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: { a: 1 } }),
    ).toMatchObject({ result: { content: [{ type: "text", text: '{"echoed":"ping"}' }] } });
    expect(plugins.calls).toEqual([
      {
        operation: "ping",
        input: { a: 1 },
        context: {
          projectId: "project",
          thread: {
            id: "thread",
            parentThreadId: "parent",
            rootThreadId: "root",
            relationshipToParent: "subagent",
          },
        },
      },
    ]);
    plugins.result = { text: "x".repeat(PLUGIN_LIMITS.maxPayloadBytes) };
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: {} }),
    ).toMatchObject({ error: { message: "The plugin request or response is too large." } });
  }),
);

it.effect("an MCP cancel notification interrupts the plugin call it names", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    plugins.call = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
    );
    const call = yield* rpc(gateway, input, "tools/call", {
      name: "plugin_echo__ping",
      arguments: {},
    }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const cancelled = yield* gateway.handle(
      input.providerSessionId,
      input.providerSessionId,
      new Request(`http://localhost/mcp/catalog/${input.providerSessionId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: encodePacket({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1, reason: "user stopped" },
        }),
      }),
    );
    expect(cancelled.status).toBe(202);
    yield* Deferred.await(interrupted);
    expect(yield* Fiber.join(call)).toHaveProperty("error");
  }),
);

it.effect(
  "disabling a plugin removes its tools from the next list and fails in-flight names with plugin-disabled",
  () =>
    Effect.gen(function* () {
      const { gateway, input, plugins } = yield* setup;
      yield* gateway.applyCatalogRevision(input);
      plugins.echo = "enabled";
      expect(yield* rpc(gateway, input, "tools/list", {})).toMatchObject({
        result: { tools: [{ name: "plugin_echo__ping" }, { name: "plugin_echo__pong" }] },
      });
      plugins.echo = "disabled";
      expect(yield* rpc(gateway, input, "tools/list", {})).toMatchObject({
        result: { tools: [] },
      });
      expect(
        yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: {} }),
      ).toMatchObject({ error: { message: 'Plugin "Echo" is disabled.' } });
      plugins.echo = "enabled";
      plugins.disabledMidCall = true;
      expect(
        yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: {} }),
      ).toMatchObject({ error: { message: 'Plugin "Echo" is disabled.' } });
      expect(plugins.calls).toEqual([]);
    }),
);

it.effect("mutating plugin tool is refused for a non-full-access thread", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins, setThreadModes } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    setThreadModes({ runtimeMode: "approval-required", interactionMode: "default" });
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__pong", arguments: {} }),
    ).toMatchObject({ error: { message: PLUGIN_MUTATION_REFUSED_MESSAGE } });
    setThreadModes({ runtimeMode: "full-access", interactionMode: "plan" });
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__pong", arguments: {} }),
    ).toMatchObject({ error: { message: PLUGIN_MUTATION_REFUSED_MESSAGE } });
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: {} }),
    ).toHaveProperty("result");
    expect(plugins.calls.map((call) => call.operation)).toEqual(["ping"]);
    setThreadModes({ runtimeMode: "full-access", interactionMode: "default" });
    plugins.threadShell = "missing";
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__pong", arguments: {} }),
    ).toMatchObject({ error: { message: PLUGIN_MUTATION_REFUSED_MESSAGE } });
    plugins.threadShell = "present";
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__pong", arguments: {} }),
    ).toHaveProperty("result");
  }),
);

it.effect("assistant policy lists and calls only selected plugin operations", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins, setAllowedTools } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    setAllowedTools(["plugin:echo:ping"]);
    const listed = (yield* rpc(gateway, input, "tools/list", {})) as {
      result: { tools: ReadonlyArray<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["plugin_echo__ping"]);
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: {} }),
    ).toHaveProperty("result");
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__pong", arguments: {} }),
    ).toMatchObject({
      error: { message: "This tool is not selected in the assistant configuration." },
    });
    expect(plugins.calls.map((call) => call.operation)).toEqual(["ping"]);
  }),
);

it.effect("assistant policy hides plugin resources and refuses reading them", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins, setAllowedTools } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    setAllowedTools(["plugin:echo:ping"]);
    expect(yield* rpc(gateway, input, "resources/list", {})).toMatchObject({
      result: { resources: [] },
    });
    expect(
      yield* rpc(gateway, input, "resources/read", { uri: "t3-plugin://echo/status" }),
    ).toMatchObject({
      error: { message: "Assistant resource access requires a configured selection." },
    });
    expect(plugins.calls).toEqual([]);
  }),
);

it.effect("reads a plugin resource through its declared operation", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    plugins.echo = "enabled";
    expect(yield* rpc(gateway, input, "resources/list", {})).toMatchObject({
      result: {
        resources: [{ uri: "t3-plugin://echo/status", name: "status", title: "Echo status" }],
      },
    });
    expect(
      yield* rpc(gateway, input, "resources/read", { uri: "t3-plugin://echo/status" }),
    ).toMatchObject({
      result: {
        contents: [
          {
            uri: "t3-plugin://echo/status",
            mimeType: "application/json",
            text: '{"echoed":"ping"}',
          },
        ],
      },
    });
    expect(plugins.calls).toEqual([
      {
        operation: "ping",
        input: {},
        context: {
          projectId: "project",
          thread: {
            id: "thread",
            parentThreadId: "parent",
            rootThreadId: "root",
            relationshipToParent: "subagent",
          },
        },
      },
    ]);
  }),
);

it.effect("plugin tools work with zero catalog entries", () =>
  Effect.gen(function* () {
    const { gateway, input, plugins } = yield* setup;
    plugins.echo = "enabled";
    expect(yield* gateway.resolveCatalogSession(input.catalogSessionId)).toBeUndefined();
    const listed = (yield* rpc(gateway, input, "tools/list", {})) as {
      result: { tools: ReadonlyArray<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "plugin_echo__ping",
      "plugin_echo__pong",
    ]);
    expect(
      yield* rpc(gateway, input, "tools/call", { name: "plugin_echo__ping", arguments: {} }),
    ).toHaveProperty("result");
    expect(plugins.calls).toHaveLength(1);
  }),
);
