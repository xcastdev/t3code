import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Client, StreamableHTTPClientTransport, type Progress } from "@modelcontextprotocol/client";
import { McpServerId, ThreadId } from "@t3tools/contracts";
import { connectProjectMcpServer } from "./ProjectMcpConnection.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";
import { makeScopedFetch } from "./ProjectMcpProxyRegistry.fetch.fixture.ts";

const makeProxy = Effect.fn(function* (modern = false, legacyUpstream = false) {
  const serverId = McpServerId.make("proxy-stdio");
  const transport = {
    type: "stdio" as const,
    command: process.execPath,
    env: [],
    args: [
      NodeURL.fileURLToPath(
        new URL(
          modern && !legacyUpstream
            ? "./ProjectMcpConnection.stdio.fixture.mjs"
            : "./ProjectMcpBroker.stdio.fixture.mjs",
          import.meta.url,
        ),
      ),
    ],
  };
  const upstream = yield* Effect.acquireRelease(
    Effect.promise(() =>
      connectProjectMcpServer({ serverId, transport, resolveSecret: () => undefined }),
    ),
    (connection) => Effect.promise(() => connection.close()),
  );
  const registry = yield* ProjectMcpProxyRegistry.__testing.make({
    endpointBase: "http://fixture.test/mcp",
    connect: async () => upstream,
  });
  const [endpoint] = yield* registry.registerSession({
    providerSessionId: "fixture",
    threadId: ThreadId.make("fixture"),
    servers: [{ id: serverId, name: "fixture", transport }],
  });
  const client = new Client(
    { name: "downstream", version: "1" },
    {
      versionNegotiation: { mode: modern ? "auto" : "legacy" },
      inputRequired: { autoFulfill: false },
      capabilities: { roots: {}, sampling: {}, elicitation: { form: {} } },
    },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
  const tokens: unknown[] = [];
  const fetch = yield* makeScopedFetch((request) =>
    registry.handle("fixture", endpoint!.endpointHandle, request),
  );
  const sdkTransport = new StreamableHTTPClientTransport(endpoint!.endpoint, { fetch });
  const send = sdkTransport.send.bind(sdkTransport);
  sdkTransport.send = async (message, options) => {
    if ("method" in message && message.method === "tools/call")
      tokens.push(message.params?._meta?.progressToken);
    return send(message, options);
  };
  yield* Effect.promise(() => client.connect(sdkTransport));
  return { client, tokens, registry, endpoint: endpoint!, fetch, sdkTransport };
});

it.effect("releases a closed legacy facade's resource ownership without closing its peer", () =>
  Effect.gen(function* () {
    const { client, fetch, sdkTransport, endpoint } = yield* makeProxy();
    const peer = new Client(
      { name: "peer", version: "1" },
      { versionNegotiation: { mode: "legacy" } },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => peer.close()));
    yield* Effect.promise(async () => {
      await peer.connect(new StreamableHTTPClientTransport(endpoint.endpoint, { fetch }));
      await client.subscribeResource({ uri: "file:///exclusive" });
      await client.subscribeResource({ uri: "file:///shared" });
      await peer.subscribeResource({ uri: "file:///shared" });
      await sdkTransport.terminateSession();
      expect((await peer.callTool({ name: "subscriptions" })).content).toEqual([
        { type: "text", text: "1" },
      ]);
      const delivered = Promise.withResolvers<string>();
      peer.setNotificationHandler("notifications/resources/updated", (notification) => {
        delivered.resolve(notification.params.uri);
      });
      await peer.callTool({ name: "emit" });
      expect(await delivered.promise).toBe("file:///shared");
      await peer.unsubscribeResource({ uri: "file:///shared" });
      expect((await peer.callTool({ name: "subscriptions" })).content).toEqual([
        { type: "text", text: "0" },
      ]);
    });
  }).pipe(Effect.scoped),
);

it.effect("revokes a connection with both a suspended tool and resource subscriptions", () =>
  Effect.gen(function* () {
    const { client, registry, endpoint } = yield* makeProxy(true, true);
    yield* Effect.promise(() => client.listen({ resourceSubscriptions: ["file:///fixture"] }));
    const pending = yield* Effect.promise(() =>
      client.callTool({ name: "roots" }, { allowInputRequired: true }),
    );
    expect(pending.resultType).toBe("input_required");
    yield* registry.revokeProviderSession("fixture");
    expect(yield* registry.resolve("fixture", endpoint.endpointHandle)).toBeUndefined();
  }),
);

it.effect("continues prompt and resource input-required results through the HTTP proxy", () =>
  Effect.gen(function* () {
    const { client } = yield* makeProxy(true);
    const prompt = (yield* Effect.promise(() =>
      client.getPrompt({ name: "needs-input" }, { allowInputRequired: true }),
    )) as unknown as { resultType?: string; requestState?: string };
    expect(prompt.resultType).toBe("input_required");
    expect(prompt.requestState).toBeTypeOf("string");
    if (typeof prompt.requestState !== "string") throw new Error("expected prompt state");
    const completedPrompt = yield* Effect.promise(() =>
      client.getPrompt(
        {
          name: "needs-input",
          requestState: prompt.requestState,
          inputResponses: { approval: { action: "accept", content: {} } },
        } as never,
        { allowInputRequired: true },
      ),
    );
    expect(completedPrompt).toMatchObject({ description: "prompt approved", messages: [] });

    const resource = (yield* Effect.promise(() =>
      client.readResource({ uri: "file:///needs-input" }, { allowInputRequired: true }),
    )) as unknown as { resultType?: string; requestState?: string };
    expect(resource.resultType).toBe("input_required");
    expect(resource.requestState).toBeTypeOf("string");
    if (typeof resource.requestState !== "string") throw new Error("expected resource state");
    const completedResource = yield* Effect.promise(() =>
      client.readResource(
        {
          uri: "file:///needs-input",
          requestState: resource.requestState,
          inputResponses: { approval: { action: "accept", content: {} } },
        } as never,
        { allowInputRequired: true },
      ),
    );
    expect(completedResource).toMatchObject({
      contents: [{ uri: "file:///needs-input", text: "resource approved" }],
    });
  }),
);

it.effect(
  "bridges legacy stdio prompt and resource requests through HTTP input-required rounds",
  () =>
    Effect.gen(function* () {
      const { client } = yield* makeProxy(true, true);
      const roots = { roots: [{ uri: "file:///workspace", name: "workspace" }] };
      client.setRequestHandler("roots/list", () => roots);

      const prompt = (yield* Effect.promise(() =>
        client.getPrompt(
          { name: "needs-roots-prompt", arguments: {} },
          { allowInputRequired: true },
        ),
      )) as unknown as { resultType?: string; requestState?: string };
      expect(prompt.resultType).toBe("input_required");
      expect(prompt.requestState).toBeTypeOf("string");
      if (typeof prompt.requestState !== "string") throw new Error("expected prompt state");
      const completedPrompt = yield* Effect.promise(() =>
        client.getPrompt(
          {
            name: "needs-roots-prompt",
            arguments: {},
            requestState: prompt.requestState,
            inputResponses: { "legacy-input-0": roots },
          } as never,
          { allowInputRequired: true },
        ),
      );
      expect(completedPrompt).toMatchObject({
        description: "file:///workspace",
        messages: [],
      });

      const resource = (yield* Effect.promise(() =>
        client.readResource({ uri: "file:///needs-roots-resource" }, { allowInputRequired: true }),
      )) as unknown as { resultType?: string; requestState?: string };
      expect(resource.resultType).toBe("input_required");
      expect(resource.requestState).toBeTypeOf("string");
      if (typeof resource.requestState !== "string") throw new Error("expected resource state");
      const completedResource = yield* Effect.promise(() =>
        client.readResource(
          {
            uri: "file:///needs-roots-resource",
            requestState: resource.requestState,
            inputResponses: { "legacy-input-0": roots },
          } as never,
          { allowInputRequired: true },
        ),
      );
      expect(completedResource).toMatchObject({
        contents: [{ uri: "file:///needs-roots-resource", text: "file:///workspace" }],
      });
    }),
);

it.effect(
  "opens modern upstream resource filters and releases them with downstream subscriptions",
  () =>
    Effect.gen(function* () {
      const { client } = yield* makeProxy(true);
      let delivered = Promise.withResolvers<void>();
      let updates = 0;
      client.setNotificationHandler("notifications/resources/updated", () => {
        updates += 1;
        delivered.resolve();
      });
      const first = yield* Effect.promise(() =>
        client.listen({ resourceSubscriptions: ["file:///fixture"] }),
      );
      const second = yield* Effect.promise(() =>
        client.listen({ resourceSubscriptions: ["file:///fixture"] }),
      );
      expect(
        (yield* Effect.promise(() => client.callTool({ name: "subscriptions" }))).content,
      ).toEqual([{ type: "text", text: '{"opened":2,"active":2}' }]);
      yield* Effect.promise(() => first.close());
      yield* Effect.promise(() => client.callTool({ name: "emit" }));
      yield* Effect.promise(() => delivered.promise);
      expect(updates).toBe(1);
      delivered = Promise.withResolvers<void>();
      yield* Effect.promise(() => second.close());
      expect(
        (yield* Effect.promise(() => client.callTool({ name: "subscriptions" }))).content,
      ).toEqual([{ type: "text", text: '{"opened":2,"active":1}' }]);
    }),
);

it.effect("bridges a modern resource filter to legacy upstream resource subscriptions", () =>
  Effect.gen(function* () {
    const { client } = yield* makeProxy(true, true);
    const delivered = Promise.withResolvers<void>();
    client.setNotificationHandler("notifications/resources/updated", () => delivered.resolve());
    const subscription = yield* Effect.promise(() =>
      client.listen({ resourceSubscriptions: ["file:///fixture"] }),
    );
    expect(
      (yield* Effect.promise(() => client.callTool({ name: "subscriptions" }))).content,
    ).toEqual([{ type: "text", text: "1" }]);
    yield* Effect.promise(() => client.callTool({ name: "emit" }));
    yield* Effect.promise(() => delivered.promise);
    yield* Effect.promise(() => subscription.close());
    expect(
      (yield* Effect.promise(() => client.callTool({ name: "subscriptions" }))).content,
    ).toEqual([{ type: "text", text: "0" }]);
  }),
);

it.effect("preserves two downstream progress tokens across the proxy and real stdio", () =>
  Effect.gen(function* () {
    const { client, tokens } = yield* makeProxy();
    const first: Progress[] = [];
    const second: Progress[] = [];
    yield* Effect.promise(() =>
      Promise.all([
        client.callTool(
          { name: "progress", arguments: { label: "first" } },
          { onprogress: (value) => first.push(value) },
        ),
        client.callTool(
          { name: "progress", arguments: { label: "second" } },
          { onprogress: (value) => second.push(value) },
        ),
      ]),
    );
    expect(new Set(tokens).size).toBe(2);
    expect(first).toEqual([expect.objectContaining({ progress: 1, message: "first" })]);
    expect(second).toEqual([expect.objectContaining({ progress: 1, message: "second" })]);
  }),
);

for (const name of ["roots", "sampling", "elicitation"] as const) {
  it.effect(
    `forwards ${name} cancellation to the downstream handler before releasing its gate`,
    () =>
      Effect.gen(function* () {
        const { client } = yield* makeProxy();
        const entered = Promise.withResolvers<void>();
        const cancelled = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
        const wait = async (signal: AbortSignal) => {
          signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
          entered.resolve();
          await gate.promise;
        };
        client.setRequestHandler("roots/list", async (_request, context) => {
          await wait(context.mcpReq.signal);
          return { roots: [{ uri: "file:///fixture" }] };
        });
        client.setRequestHandler("sampling/createMessage", async (_request, context) => {
          await wait(context.mcpReq.signal);
          return {
            model: "fixture",
            role: "assistant",
            content: { type: "text", text: "fixture" },
          };
        });
        client.setRequestHandler("elicitation/create", async (_request, context) => {
          await wait(context.mcpReq.signal);
          return { action: "cancel" };
        });
        const abort = new AbortController();
        const result = client.callTool({ name }, { signal: abort.signal }).then(
          () => "completed",
          (error: unknown) => String(error),
        );
        yield* Effect.promise(() =>
          Promise.race([
            entered.promise,
            result.then((value) => {
              throw new Error(`Tool finished before handler entered: ${value}`);
            }),
          ]),
        );
        abort.abort();
        yield* Effect.promise(() => cancelled.promise);
        expect(yield* Effect.promise(() => result)).not.toBe("completed");
        gate.resolve();
      }),
  );
}
