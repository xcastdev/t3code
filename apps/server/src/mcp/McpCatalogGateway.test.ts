import * as Schema from "effect/Schema";
import { AssistantNativeResources } from "../assistants/AssistantNativeResources.ts";
import { expect, it } from "@effect/vitest";
import {
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
import { __testing, namespaceName, type RegisterCatalogSessionInput } from "./McpCatalogGateway.ts";
import { McpSessionRegistry, type McpNativeRuntimeBinding } from "./McpSessionRegistry.ts";
import { ProjectMcpProxyRegistry, ProjectMcpConnectionError } from "./ProjectMcpProxyRegistry.ts";

const setup = Effect.gen(function* () {
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
    resolve: () => Effect.succeed(undefined),
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
  const gateway = yield* __testing.make.pipe(
    Effect.provideService(AssistantNativeResources, {
      tools: () => Effect.sync(() => allowedTools),
    }),
    Effect.provideService(McpSessionRegistry, registry),
    Effect.provideService(ProjectMcpProxyRegistry, proxy),
  );
  const input: RegisterCatalogSessionInput = {
    ...binding,
    catalogSessionId: McpCatalogSessionId.make("catalog"),
    revision: 1,
    entries: [],
  };
  return {
    gateway,
    input,
    setAllowedTools: (value: ReadonlyArray<string> | undefined) => {
      allowedTools = value;
    },
    registry,
    setConnect: (value: typeof connect) => {
      connect = value;
    },
  };
});

it.effect("failed complete staging retains the previous applied catalog", () =>
  Effect.gen(function* () {
    const { gateway, input } = yield* setup;
    yield* gateway.applyCatalogRevision(input);
    const failure = yield* gateway
      .applyCatalogRevision({
        ...input,
        revision: 2,
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
      .pipe(Effect.flip);
    expect(failure.message).toBe("MCP catalog apply failed.");
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
      const prefix = "mcp_" + Buffer.from("server").toString("hex") + "__";
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
        result: { tools: [{ name: namespaceName(logicalServerId, "read") }] },
      });
      yield* request("tools/call", {
        name: namespaceName(logicalServerId, "write"),
        arguments: {},
      });
      expect(calls).toBe(0);
      yield* request("tools/call", { name: namespaceName(logicalServerId, "read"), arguments: {} });
      expect(calls).toBe(1);
      setAllowedTools([]);
      yield* request("tools/call", { name: namespaceName(logicalServerId, "read"), arguments: {} });
      expect(calls).toBe(1);
    }),
);
