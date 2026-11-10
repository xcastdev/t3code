import { expect, it } from "@effect/vitest";
import { OmpToolBridge } from "./toolBridge.ts";
it("replaces catalogs, aborts and closes revoked native calls, discards stale results and preserves output", async () => {
  const records: Record<string, unknown>[] = [];
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<unknown>();
  const bridge = new OmpToolBridge(
    async (r) => {
      records.push(r);
    },
    async (_name, _args, signal) => {
      started.resolve(signal);
      return release.promise;
    },
  );
  const tools = [{ name: "pty", description: "Terminal", inputSchema: { type: "object" } }];
  await bridge.replace(tools, "session:grant1");
  const work = bridge.handle({
    type: "host_tool_call",
    id: "a",
    toolName: "pty",
    toolCallId: "t",
    arguments: { command: "ls" },
  });
  const signal = await started.promise;
  await bridge.replace([], "session:grant2");
  expect(signal.aborted).toBe(true);
  release.resolve({ content: [{ type: "text", text: "secret late data" }] });
  await work;
  expect(records.filter((r) => r.type === "host_tool_result")).toEqual([
    {
      type: "host_tool_result",
      id: "a",
      isError: true,
      result: { content: [{ type: "text", text: "Tool authorization or catalog changed" }] },
    },
  ]);
  await bridge.handle({ type: "host_tool_call", id: "b", toolName: "pty", arguments: {} });
  expect(records.at(-1)?.isError).toBe(true);
});
it("separates native cancellation, tool errors and sanitized transport failures", async () => {
  const sent: Record<string, unknown>[] = [];
  const bridge = new OmpToolBridge(
    async (r) => {
      sent.push(r);
    },
    async (name) => {
      if (name === "bad") throw new Error("Bearer secret");
      return {
        isError: true,
        content: [
          { type: "text", text: "tool failed" },
          { type: "image", mimeType: "image/png", data: "YQ==" },
        ],
      };
    },
  );
  await bridge.replace(
    [
      { name: "bad", inputSchema: {} },
      { name: "ok", inputSchema: {} },
    ],
    "g",
  );
  await bridge.handle({ type: "host_tool_call", id: "1", toolName: "ok", arguments: {} });
  expect(sent.at(-1)).toMatchObject({
    isError: true,
    result: { content: [{ text: "tool failed" }, { data: "YQ==" }] },
  });
  await bridge.handle({ type: "host_tool_call", id: "2", toolName: "bad", arguments: {} });
  expect(JSON.stringify(sent.at(-1))).not.toContain("secret");
  await bridge.close();
  expect(sent.at(-1)).toEqual({ type: "set_host_tools", tools: [] });
});

it("streams correlated authorized MCP progress before its final HTTP record and preserves the native image result", async () => {
  const { AuthorizedMcpClient } = await import("./toolBridge.ts");
  const progress = Promise.withResolvers<unknown>();
  let responseId: unknown;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const client = new AuthorizedMcpClient(
    { endpoint: "https://fixture.test/mcp", authorizationHeader: "Bearer private" },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private");
      if (body.method === "initialize")
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } },
          { headers: { "mcp-session-id": "negotiated-session" } },
        );
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("negotiated-session");
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      responseId = body.id;
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify({
                    jsonrpc: "2.0",
                    method: "notifications/progress",
                    params: {
                      progressToken: body.params._meta.progressToken,
                      message: "working 😀",
                    },
                  }) +
                  "\n\n",
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  await client.connect(new AbortController().signal);
  const result = client.callTool("tool", {}, new AbortController().signal, async (update) => {
    progress.resolve(update);
  });
  void result.catch((error) => progress.reject(error));
  expect(await progress.promise).toMatchObject({ content: [{ type: "text", text: "working 😀" }] });
  stream!.enqueue(
    new TextEncoder().encode(
      "data: " +
        JSON.stringify({
          jsonrpc: "2.0",
          id: responseId,
          result: { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }] },
        }) +
        "\n\n",
    ),
  );
  stream!.close();
  expect(await result).toMatchObject({ content: [{ type: "image", data: "YQ==" }] });
});
it("refuses host catalog names that shadow native execution boundaries", async () => {
  const bridge = new OmpToolBridge(
    async () => {},
    async () => ({}),
  );
  for (const name of ["eval", "bash", "read", "edit", "write"])
    await expect(bridge.replace([{ name, inputSchema: {} }], "g")).rejects.toThrow(/native/i);
});
it("lists T3 and catalog tools together and sends each call to the server that listed it", async () => {
  const { connectAuthorizedMcpTools } = await import("./toolBridge.ts");
  const served: Record<string, ReadonlyArray<string>> = {
    "https://fixture.test/mcp": ["t3_thread_list", "t3_thread_send"],
    "https://fixture.test/mcp/catalog/s1": ["plugin_inspector__headers"],
  };
  const readOnly = new Set(["t3_thread_list", "plugin_inspector__headers"]);
  const calls: string[] = [];
  const authorized = await connectAuthorizedMcpTools(
    {
      endpoint: "https://fixture.test/mcp",
      catalogEndpoint: "https://fixture.test/mcp/catalog/s1",
      authorizationHeader: "Bearer private",
    },
    new AbortController().signal,
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : body.method === "tools/list"
            ? {
                tools: served[String(url)]!.map((name) => ({
                  name,
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: readOnly.has(name) },
                })),
              }
            : { content: [{ type: "text", text: String(url) }] };
      if (body.method === "tools/call") calls.push(`${body.params.name}@${String(url)}`);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  );
  expect(authorized.tools.map((tool) => tool.name)).toEqual([
    "t3_thread_list",
    "t3_thread_send",
    "plugin_inspector__headers",
  ]);
  expect([...authorized.t3ToolNames]).toEqual(["t3_thread_list", "t3_thread_send"]);
  expect([...authorized.readOnlyT3ToolNames]).toEqual(["t3_thread_list"]);
  const signal = new AbortController().signal;
  await authorized.callTool("t3_thread_list", {}, signal);
  await authorized.callTool("plugin_inspector__headers", {}, signal);
  expect(calls).toEqual([
    "t3_thread_list@https://fixture.test/mcp",
    "plugin_inspector__headers@https://fixture.test/mcp/catalog/s1",
  ]);
  await expect(authorized.callTool("unlisted", {}, signal)).rejects.toThrow(/unavailable/);
});
it("keeps pending calls to kept tools across a catalog swap and cancels the rest", async () => {
  const records: Record<string, unknown>[] = [];
  const signals = new Map<string, AbortSignal>();
  const started = { t3: Promise.withResolvers<void>(), catalog: Promise.withResolvers<void>() };
  const release = Promise.withResolvers<unknown>();
  const bridge = new OmpToolBridge(
    async (r) => {
      records.push(r);
    },
    async (name, _args, signal) => {
      signals.set(name, signal);
      started[name === "t3_thread_wait" ? "t3" : "catalog"].resolve();
      return release.promise;
    },
  );
  const t3 = { name: "t3_thread_wait", inputSchema: {} };
  const catalog = { name: "docs__search", inputSchema: {} };
  await bridge.replace([t3, catalog], "g1");
  const t3Call = bridge.handle({
    type: "host_tool_call",
    id: "a",
    toolName: t3.name,
    arguments: {},
  });
  const catalogCall = bridge.handle({
    type: "host_tool_call",
    id: "b",
    toolName: catalog.name,
    arguments: {},
  });
  await Promise.all([started.t3.promise, started.catalog.promise]);
  const keep = new Set([t3.name]);
  await bridge.replace([], "", keep);
  await bridge.replace([t3, catalog], "g2", keep);
  expect(signals.get(t3.name)?.aborted).toBe(false);
  expect(signals.get(catalog.name)?.aborted).toBe(true);
  release.resolve({ content: [{ type: "text", text: "done" }] });
  await Promise.all([t3Call, catalogCall]);
  expect(records.filter((r) => r.type === "host_tool_result")).toEqual([
    {
      type: "host_tool_result",
      id: "b",
      isError: true,
      result: { content: [{ type: "text", text: "Tool authorization or catalog changed" }] },
    },
    { type: "host_tool_result", id: "a", result: { content: [{ type: "text", text: "done" }] } },
  ]);
});
