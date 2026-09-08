import { McpServerId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { JSONObjectSchema, JSONValueSchema } from "@modelcontextprotocol/core";
import type { Client, InputRequiredResult } from "@modelcontextprotocol/client";
import type { ProjectMcpClient } from "./ProjectMcpConnection.ts";
import type { ProjectMcpCallToolParams } from "./ProjectMcpBroker.ts";

import { ProjectMcpBroker, ProjectMcpBrokerError } from "./ProjectMcpBroker.ts";

const serverId = McpServerId.make("mcp-broker");

const makeClient = (overrides: Partial<ProjectMcpClient> = {}): ProjectMcpClient => ({
  connect: async () => undefined,
  close: async () => undefined,
  ...overrides,
});

const connection = (client: ProjectMcpClient, protocolEra: "legacy" | "modern" = "modern") => ({
  client,
  transport: { type: "stdio", command: "fixture", args: [], env: [] } as const,
  protocolEra,
  negotiatedProtocolVersion: protocolEra === "modern" ? "2026-07-28" : "2025-11-25",
  discoverResult: undefined,
  close: async () => undefined,
});

it("exposes standard SDK operations without exposing the upstream client", async () => {
  const result = {
    tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
  } satisfies Awaited<ReturnType<Client["listTools"]>>;
  const broker = new ProjectMcpBroker({
    connection: connection(makeClient({ listTools: async () => result })),
    serverId,
    providerSessionId: "provider-session",
  });

  await expect(broker.listTools()).resolves.toEqual(result);
  expect("client" in broker).toBe(false);
});

it("signs input-required state and restores the upstream request state on retry", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = makeClient({
    callTool: (async (params: ProjectMcpCallToolParams) => {
      calls.push(params);
      return calls.length === 1
        ? ({
            resultType: "input_required",
            inputRequests: {
              approval: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "Approve?",
                  requestedSchema: { type: "object", properties: {} },
                },
              } as unknown as NonNullable<InputRequiredResult["inputRequests"]>[string],
            },
            requestState: "upstream-state",
          } satisfies InputRequiredResult)
        : { content: [{ type: "text", text: "approved" }], isError: false };
    }) as NonNullable<ProjectMcpClient["callTool"]>,
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client),
    serverId,
    providerSessionId: "provider-session",
    requestStateSecret: "broker-secret",
  });

  const pending = await broker.callTool({ name: "approval", arguments: { id: "one" } });
  expect(pending.resultType).toBe("input_required");
  expect(pending.requestState).toBeTypeOf("string");
  expect(pending.requestState).not.toBe("upstream-state");
  if (typeof pending.requestState !== "string") throw new Error("expected signed request state");

  const complete = await broker.callTool({
    name: "approval",
    arguments: { id: "one" },
    inputResponses: { approval: { action: "accept", content: {} } },
    requestState: pending.requestState,
  });
  expect(complete).toEqual({ content: [{ type: "text", text: "approved" }], isError: false });
  expect(calls[1]).toEqual({
    name: "approval",
    arguments: { id: "one" },
    inputResponses: { approval: { action: "accept", content: {} } },
    requestState: "upstream-state",
  });
});

it.each([
  ["getPrompt", { name: "approval", arguments: { subject: "one" } }],
  ["readResource", { uri: "file:///workspace/one" }],
] as const)("supports signed input-required continuation for %s", async (method, params) => {
  const calls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const client = makeClient({
    getPrompt: (async (request, options) => {
      calls.push({ params: request as Record<string, unknown>, options: options ?? {} });
      if (options?.allowInputRequired !== true)
        throw new Error("manual input-required mode was not enabled");
      return calls.length === 1
        ? ({
            resultType: "input_required",
            inputRequests: {
              approval: {
                method: "elicitation/create",
                params: { mode: "form", message: "Approve?", requestedSchema: {} },
              },
            },
            requestState: "upstream-state",
          } as never)
        : ({ description: "approved", messages: [] } as never);
    }) as NonNullable<ProjectMcpClient["getPrompt"]>,
    readResource: (async (request, options) => {
      calls.push({ params: request as Record<string, unknown>, options: options ?? {} });
      if (options?.allowInputRequired !== true)
        throw new Error("manual input-required mode was not enabled");
      return calls.length === 1
        ? ({
            resultType: "input_required",
            inputRequests: {
              approval: {
                method: "elicitation/create",
                params: { mode: "form", message: "Approve?", requestedSchema: {} },
              },
            },
            requestState: "upstream-state",
          } as never)
        : ({ contents: [{ uri: request.uri, text: "approved" }] } as never);
    }) as NonNullable<ProjectMcpClient["readResource"]>,
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client),
    serverId,
    providerSessionId: "provider-session",
    requestStateSecret: "broker-secret",
  });

  const first = (method === "getPrompt"
    ? await broker.getPrompt(params as never)
    : await broker.readResource(params as never)) as unknown as InputRequiredResult;
  expect(first.resultType).toBe("input_required");
  expect(first.requestState).toBeTypeOf("string");
  if (typeof first.requestState !== "string") throw new Error("expected signed request state");

  const retry = {
    ...params,
    inputResponses: { approval: { action: "accept", content: {} } },
    requestState: first.requestState,
  };
  const complete =
    method === "getPrompt"
      ? await broker.getPrompt(retry as never)
      : await broker.readResource(retry as never);
  expect(complete).toEqual(
    method === "getPrompt"
      ? { description: "approved", messages: [] }
      : { contents: [{ uri: "file:///workspace/one", text: "approved" }] },
  );
  expect(calls[1]?.params).toEqual({
    ...params,
    inputResponses: { approval: { action: "accept", content: {} } },
    requestState: "upstream-state",
  });
  expect(calls[1]?.options.allowInputRequired).toBe(true);
});

it("does not let continuation state cross methods or original parameters", async () => {
  let promptCalls = 0;
  let resourceCalls = 0;
  const client = makeClient({
    getPrompt: (async () => {
      promptCalls += 1;
      return {
        resultType: "input_required",
        inputRequests: {
          approval: {
            method: "elicitation/create",
            params: { mode: "form", message: "Approve?", requestedSchema: {} },
          },
        },
        requestState: "prompt-state",
      } as never;
    }) as NonNullable<ProjectMcpClient["getPrompt"]>,
    readResource: (async () => {
      resourceCalls += 1;
      return { contents: [{ uri: "file:///other", text: "unexpected" }] } as never;
    }) as NonNullable<ProjectMcpClient["readResource"]>,
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client),
    serverId,
    providerSessionId: "provider-session",
    requestStateSecret: "broker-secret",
  });
  const first = (await broker.getPrompt({ name: "approval" })) as unknown as InputRequiredResult;
  if (typeof first.requestState !== "string") throw new Error("expected signed request state");

  await expect(
    broker.readResource({
      uri: "file:///other",
      requestState: first.requestState,
      inputResponses: { approval: {} },
    } as never),
  ).rejects.toMatchObject({ code: "invalid_request_state" });
  await expect(
    broker.getPrompt({
      name: "changed",
      requestState: first.requestState,
      inputResponses: { approval: {} },
    } as never),
  ).rejects.toMatchObject({ code: "invalid_request_state" });
  expect(promptCalls).toBe(1);
  expect(resourceCalls).toBe(0);
});

it("rejects expired continuation state before contacting the upstream method", async () => {
  let timestamp = 1_000;
  let calls = 0;
  const broker = new ProjectMcpBroker({
    connection: connection(
      makeClient({
        getPrompt: (async () => {
          calls += 1;
          return {
            resultType: "input_required",
            inputRequests: {
              approval: {
                method: "elicitation/create",
                params: { mode: "form", message: "Approve?", requestedSchema: {} },
              },
            },
          } as never;
        }) as NonNullable<ProjectMcpClient["getPrompt"]>,
      }),
    ),
    serverId,
    providerSessionId: "provider-session",
    requestStateSecret: "broker-secret",
    now: () => timestamp,
  });
  const first = (await broker.getPrompt({ name: "approval" })) as unknown as InputRequiredResult;
  if (typeof first.requestState !== "string") throw new Error("expected signed request state");
  timestamp += 10 * 60 * 1000 + 1;

  await expect(
    broker.getPrompt({
      name: "approval",
      requestState: first.requestState,
      inputResponses: { approval: {} },
    } as never),
  ).rejects.toMatchObject({ code: "invalid_request_state" });
  expect(calls).toBe(1);
});

it("rejects a continuation beyond the maximum input round", async () => {
  const broker = new ProjectMcpBroker({
    connection: connection(
      makeClient({
        getPrompt: (async () =>
          ({
            resultType: "input_required",
            inputRequests: {
              approval: {
                method: "elicitation/create",
                params: { mode: "form", message: "Approve?", requestedSchema: {} },
              },
            },
          }) as never) as NonNullable<ProjectMcpClient["getPrompt"]>,
      }),
    ),
    serverId,
    providerSessionId: "provider-session",
    requestStateSecret: "broker-secret",
  });
  let state: string | undefined;
  for (let round = 0; round <= 10; round += 1) {
    const result = (await broker.getPrompt({
      name: "approval",
      ...(state === undefined ? {} : { requestState: state, inputResponses: { approval: {} } }),
    } as never)) as unknown as InputRequiredResult;
    if (typeof result.requestState !== "string") throw new Error("expected signed request state");
    state = result.requestState;
  }

  await expect(
    broker.getPrompt({
      name: "approval",
      requestState: state,
      inputResponses: { approval: {} },
    } as never),
  ).rejects.toMatchObject({ code: "input_round_limit" });
});

it("passes prompt cancellation through to the upstream method", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const client = makeClient({
    getPrompt: (async (_params, options) => {
      if (!options?.signal) throw new Error("missing cancellation signal");
      entered.resolve(options.signal);
      await new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        });
      });
      return { messages: [] } as never;
    }) as NonNullable<ProjectMcpClient["getPrompt"]>,
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client),
    serverId,
    providerSessionId: "provider-session",
  });
  const abort = new AbortController();
  const pending = broker.getPrompt({ name: "approval" }, { signal: abort.signal });
  expect(await entered.promise).toBe(abort.signal);
  abort.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
});

it("bridges legacy upstream server requests through modern input-required rounds", async () => {
  let rootsHandler: ((request: unknown) => unknown | Promise<unknown>) | undefined;
  const roots = { roots: [{ uri: "file:///workspace", name: "workspace" }] };
  const client = makeClient({
    setRequestHandler: ((method: string, handler: (request: unknown) => unknown) => {
      if (method === "roots/list") rootsHandler = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
    callTool: (async () => {
      if (rootsHandler === undefined) throw new Error("roots handler was not installed");
      const result = await rootsHandler({
        jsonrpc: "2.0",
        id: 1,
        method: "roots/list",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };
    }) as NonNullable<ProjectMcpClient["callTool"]>,
  });
  let forwarded = 0;
  const broker = new ProjectMcpBroker({
    connection: connection(client, "legacy"),
    serverId,
    providerSessionId: "provider-session",
    downstreamProtocolEra: "modern",
    requestStateSecret: "broker-secret",
    handlers: {
      onRootsRequest: async () => {
        forwarded += 1;
        return roots;
      },
    },
  });

  const pending = await broker.callTool({ name: "needs-roots", arguments: {} });
  expect(pending).toMatchObject({
    resultType: "input_required",
    inputRequests: { "legacy-input-0": { method: "roots/list" } },
  });
  if (pending.resultType !== "input_required" || typeof pending.requestState !== "string")
    throw new Error("expected a signed input-required state");

  const complete = await broker.callTool({
    name: "needs-roots",
    arguments: {},
    inputResponses: { "legacy-input-0": roots },
    requestState: pending.requestState,
  });
  expect(complete).toEqual({
    content: [{ type: "text", text: JSON.stringify(roots) }],
    isError: false,
  });
  expect(forwarded).toBe(0);
});

it.each([
  ["getPrompt", "roots/list"],
  ["getPrompt", "sampling/createMessage"],
  ["getPrompt", "elicitation/create"],
  ["readResource", "roots/list"],
  ["readResource", "sampling/createMessage"],
  ["readResource", "elicitation/create"],
] as const)("bridges legacy %s server requests for %s", async (operationMethod, pushMethod) => {
  let pushHandler: ((request: unknown, context: unknown) => unknown | Promise<unknown>) | undefined;
  let response: unknown;
  const expectedResponse =
    pushMethod === "roots/list"
      ? { roots: [{ uri: "file:///workspace" }] }
      : pushMethod === "sampling/createMessage"
        ? { model: "fixture", role: "assistant", content: { type: "text", text: "ok" } }
        : { action: "accept", content: {} };
  let calls = 0;
  const client = makeClient({
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === pushMethod) pushHandler = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
    ...(operationMethod === "getPrompt"
      ? {
          getPrompt: (async (params, options) => {
            calls += 1;
            if (!pushHandler) throw new Error("push handler was not installed");
            response = await pushHandler(
              { jsonrpc: "2.0", id: calls, method: pushMethod, params: {} },
              { mcpReq: { signal: options?.signal ?? new AbortController().signal } },
            );
            return {
              description: JSON.stringify({ params, response }),
              messages: [],
            };
          }) as NonNullable<ProjectMcpClient["getPrompt"]>,
        }
      : {
          readResource: (async (params, options) => {
            calls += 1;
            if (!pushHandler) throw new Error("push handler was not installed");
            response = await pushHandler(
              { jsonrpc: "2.0", id: calls, method: pushMethod, params: {} },
              { mcpReq: { signal: options?.signal ?? new AbortController().signal } },
            );
            return {
              contents: [{ uri: params.uri, text: JSON.stringify({ params, response }) }],
            };
          }) as NonNullable<ProjectMcpClient["readResource"]>,
        }),
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client, "legacy"),
    serverId,
    providerSessionId: `${operationMethod}-${pushMethod}`,
    downstreamProtocolEra: "modern",
    requestStateSecret: "broker-secret",
    handlers: {
      onRootsRequest: () => expectedResponse,
      onSamplingRequest: () => ({
        model: "fixture",
        role: "assistant",
        content: { type: "text", text: "ok" },
      }),
      onElicitationRequest: () => ({ action: "accept", content: {} }),
    },
  });
  const params =
    operationMethod === "getPrompt"
      ? { name: "needs-input", arguments: { subject: "workspace" } }
      : { uri: "file:///needs-input" };

  const first = (
    operationMethod === "getPrompt"
      ? await broker.getPrompt(params as never)
      : await broker.readResource(params as never)
  ) as InputRequiredResult;
  expect(first).toMatchObject({
    resultType: "input_required",
    inputRequests: { "legacy-input-0": { method: pushMethod } },
  });
  expect(first.requestState).toBeTypeOf("string");
  if (typeof first.requestState !== "string") throw new Error("expected signed request state");

  const completedParams = {
    ...params,
    inputResponses: { "legacy-input-0": expectedResponse },
    requestState: first.requestState,
  } as never;
  const completed =
    operationMethod === "getPrompt"
      ? await broker.getPrompt(completedParams)
      : await broker.readResource(completedParams);
  expect(completed).toMatchObject(
    operationMethod === "getPrompt"
      ? { description: expect.stringContaining('"response"') }
      : { contents: [{ uri: "file:///needs-input", text: expect.stringContaining('"response"') }] },
  );
  expect(response).toEqual(expectedResponse);
  expect(calls).toBe(1);
});

it("rejects a legacy prompt continuation through the resource method", async () => {
  let rootsHandler:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  let promptCalls = 0;
  let resourceCalls = 0;
  const client = makeClient({
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsHandler = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
    getPrompt: (async () => {
      promptCalls += 1;
      if (!rootsHandler) throw new Error("roots handler was not installed");
      await rootsHandler(
        { method: "roots/list" },
        { mcpReq: { signal: new AbortController().signal } },
      );
      return { messages: [] };
    }) as NonNullable<ProjectMcpClient["getPrompt"]>,
    readResource: (async () => {
      resourceCalls += 1;
      return { contents: [] };
    }) as NonNullable<ProjectMcpClient["readResource"]>,
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client, "legacy"),
    serverId,
    providerSessionId: "legacy-method-binding",
    downstreamProtocolEra: "modern",
    requestStateSecret: "broker-secret",
    handlers: { onRootsRequest: () => ({ roots: [] }) },
  });
  const first = (await broker.getPrompt({ name: "needs-input" })) as InputRequiredResult;
  if (typeof first.requestState !== "string") throw new Error("expected signed request state");
  await expect(
    broker.readResource({
      uri: "file:///wrong-method",
      inputResponses: { "legacy-input-0": { roots: [] } },
      requestState: first.requestState,
    }),
  ).rejects.toMatchObject({ code: "invalid_request_state" });
  expect(promptCalls).toBe(1);
  expect(resourceCalls).toBe(0);
  await broker.close();
});

it("cancels a suspended legacy resource operation and cannot revive it", async () => {
  let rootsHandler:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  const entered = Promise.withResolvers<void>();
  const client = makeClient({
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsHandler = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
    readResource: (async (_params, options) => {
      if (!rootsHandler) throw new Error("roots handler was not installed");
      await rootsHandler(
        { method: "roots/list" },
        { mcpReq: { signal: options?.signal ?? new AbortController().signal } },
      );
      if (!options?.signal) throw new Error("missing cancellation signal");
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        });
      });
      return { contents: [] };
    }) as NonNullable<ProjectMcpClient["readResource"]>,
  });
  const broker = new ProjectMcpBroker({
    connection: connection(client, "legacy"),
    serverId,
    providerSessionId: "legacy-cancellation",
    downstreamProtocolEra: "modern",
    requestStateSecret: "broker-secret",
    handlers: { onRootsRequest: () => ({ roots: [] }) },
  });
  const first = (await broker.readResource({ uri: "file:///needs-input" })) as InputRequiredResult;
  if (typeof first.requestState !== "string") throw new Error("expected signed request state");
  const abort = new AbortController();
  const pending = broker.readResource(
    {
      uri: "file:///needs-input",
      inputResponses: { "legacy-input-0": { roots: [] } },
      requestState: first.requestState,
    },
    { signal: abort.signal },
  );
  await entered.promise;
  abort.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  await expect(
    broker.readResource({
      uri: "file:///needs-input",
      inputResponses: { "legacy-input-0": { roots: [] } },
      requestState: first.requestState,
    }),
  ).rejects.toMatchObject({ code: "invalid_request_state" });
  await broker.close();
});

it("rejects tampered input state before contacting the upstream server", async () => {
  let calls = 0;
  const broker = new ProjectMcpBroker({
    connection: connection(
      makeClient({
        callTool: async () => {
          calls += 1;
          return { content: [], isError: false };
        },
      }),
    ),
    serverId,
    providerSessionId: "provider-session",
    requestStateSecret: "broker-secret",
  });

  await expect(
    broker.callTool({
      name: "approval",
      arguments: {},
      requestState: "eyJ2IjoxfQ.invalid-signature",
      inputResponses: {},
    }),
  ).rejects.toMatchObject({ code: "invalid_request_state" });
  expect(calls).toBe(0);
});

it("rejects unassociated upstream push requests with a typed unsupported-operation error", async () => {
  let requestRoots: ((request: unknown) => unknown) | undefined;
  const broker = new ProjectMcpBroker({
    connection: connection(
      makeClient({
        setRequestHandler: ((method: string, handler: (request: unknown) => unknown) => {
          if (method === "roots/list") requestRoots = handler;
        }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
      }),
      "legacy",
    ),
    serverId,
    providerSessionId: "fixture",
    downstreamProtocolEra: "modern",
    handlers: {
      onRootsRequest: () => {
        throw new Error("must not forward");
      },
    },
  });
  try {
    expect(() => requestRoots?.({ method: "roots/list" })).toThrow(
      expect.objectContaining({ code: -32601 }),
    );
  } finally {
    await broker.close();
  }
});

it("allows a validated custom request only when both sides use the same era", async () => {
  const seen: unknown[] = [];
  const broker = new ProjectMcpBroker({
    connection: connection(
      makeClient({
        request: (async (request: { method: string; params?: Record<string, unknown> }) => {
          seen.push(request);
          return { answer: "ok" };
        }) as NonNullable<ProjectMcpClient["request"]>,
      }),
    ),
    serverId,
    providerSessionId: "provider-session",
    downstreamProtocolEra: "modern",
  });

  await expect(
    broker.requestExtension(
      "example/search",
      { query: "mcp" },
      { params: JSONObjectSchema, result: JSONValueSchema },
    ),
  ).resolves.toEqual({ answer: "ok" });
  expect(seen).toEqual([{ method: "example/search", params: { query: "mcp" } }]);
});

it("rejects a custom request across eras without an explicit adapter", async () => {
  const broker = new ProjectMcpBroker({
    connection: connection(makeClient({ request: async () => ({}) }), "modern"),
    serverId,
    providerSessionId: "provider-session",
    downstreamProtocolEra: "legacy",
  });

  await expect(
    broker.requestExtension(
      "tasks/get",
      { taskId: "task" },
      { params: JSONObjectSchema, result: JSONValueSchema },
    ),
  ).rejects.toBeInstanceOf(ProjectMcpBrokerError);
  await expect(
    broker.requestExtension(
      "tasks/get",
      { taskId: "task" },
      { params: JSONObjectSchema, result: JSONValueSchema },
    ),
  ).rejects.toMatchObject({ code: "unsupported_extension_across_protocol_eras" });
});

it("does not treat standard protocol methods as extensions", async () => {
  const broker = new ProjectMcpBroker({
    connection: connection(makeClient({ request: async () => ({}) })),
    serverId,
    providerSessionId: "provider-session",
  });

  for (const method of [
    "initialize",
    "roots/list",
    "sampling/createMessage",
    "elicitation/create",
    "subscriptions/listen",
  ]) {
    await expect(
      broker.requestExtension(method, {}, { params: JSONObjectSchema, result: JSONValueSchema }),
    ).rejects.toMatchObject({ code: "invalid_extension_params" });
  }
});

it("relays list-change notifications through the semantic handler surface", async () => {
  let toolsChanged: unknown;
  let registered: ((notification: unknown) => void | Promise<void>) | undefined;
  const broker = new ProjectMcpBroker({
    connection: connection(
      makeClient({
        listTools: async () => ({
          tools: [{ name: "new-tool", inputSchema: { type: "object" as const } }],
        }),
        setNotificationHandler: ((method: string, handler: unknown) => {
          if (method === "notifications/tools/list_changed")
            registered = handler as typeof registered;
        }) as NonNullable<ProjectMcpClient["setNotificationHandler"]>,
      }),
    ),
    serverId,
    providerSessionId: "provider-session",
    handlers: {
      onToolsChanged: (tools) => {
        toolsChanged = tools;
      },
    },
  });

  void broker;
  await registered?.({ method: "notifications/tools/list_changed" });
  expect(toolsChanged).toEqual({
    tools: [{ name: "new-tool", inputSchema: { type: "object" } }],
  });
});

it("associates unsolicited legacy roots requests with the notifying facade", async () => {
  let rootsRequest:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  const forwarded: unknown[] = [];
  const client = makeClient({
    notification: (notification) => {
      forwarded.push(notification);
      return Promise.resolve();
    },
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsRequest = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
  });
  const shared = connection(client, "legacy");
  const rootsA = { roots: [{ uri: "file:///a" }] };
  const rootsB = { roots: [{ uri: "file:///b" }] };
  const first = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "first",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => rootsA },
  });
  const second = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "second",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => rootsB },
  });
  const notify = (first as unknown as { notifyRootsListChanged?: () => Promise<void> })
    .notifyRootsListChanged;
  expect(notify).toBeTypeOf("function");
  if (notify === undefined || rootsRequest === undefined) throw new Error("missing roots seam");
  const request = rootsRequest;
  await notify.call(first);
  expect(forwarded).toEqual([{ method: "notifications/roots/list_changed" }]);

  const context = { mcpReq: { signal: new AbortController().signal } };
  expect(await request({ method: "roots/list" }, context)).toEqual(rootsA);
  await first.dispose();
  await expect(
    Promise.resolve().then(() => request({ method: "roots/list" }, context)),
  ).rejects.toMatchObject({
    code: -32601,
    message: "Unassociated MCP server request is unsupported",
  });

  const notifySecond = (second as unknown as { notifyRootsListChanged: () => Promise<void> })
    .notifyRootsListChanged;
  await notifySecond.call(second);
  expect(await request({ method: "roots/list" }, context)).toEqual(rootsB);
  await second.close();
});

it("rolls back a failed roots notification to the healthy owner", async () => {
  let rootsRequest:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  let notificationCount = 0;
  const failure = new Error("notification failed");
  const client = makeClient({
    notification: async () => {
      notificationCount += 1;
      if (notificationCount === 2) throw failure;
    },
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsRequest = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
  });
  const shared = connection(client, "legacy");
  const first = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-healthy",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///healthy" }] }) },
  });
  const second = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-failed",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///failed" }] }) },
  });
  if (!rootsRequest) throw new Error("roots handler was not installed");
  await first.notifyRootsListChanged();
  await expect(second.notifyRootsListChanged()).rejects.toBe(failure);
  expect(await rootsRequest({}, { mcpReq: { signal: new AbortController().signal } })).toEqual({
    roots: [{ uri: "file:///healthy" }],
  });
  await first.dispose();
  await second.dispose();
});

it("does not let a stale failed roots notification erase a newer owner", async () => {
  let rootsRequest:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  const notifications: Array<PromiseWithResolvers<void>> = [];
  const entered = Promise.withResolvers<void>();
  const failure = new Error("stale notification failed");
  const client = makeClient({
    notification: () => {
      const pending = Promise.withResolvers<void>();
      notifications.push(pending);
      entered.resolve();
      return pending.promise;
    },
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsRequest = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
  });
  const shared = connection(client, "legacy");
  const first = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-stale-a",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///a" }] }) },
  });
  const second = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-stale-b",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///b" }] }) },
  });
  const third = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-stale-c",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///c" }] }) },
  });
  if (!rootsRequest) throw new Error("roots handler was not installed");
  const pendingSecond = second.notifyRootsListChanged();
  await entered.promise;
  const pendingThird = third.notifyRootsListChanged();
  while (notifications.length < 2) await Promise.resolve();
  notifications[1]!.resolve();
  await pendingThird;
  notifications[0]!.reject(failure);
  await expect(pendingSecond).rejects.toBe(failure);
  expect(await rootsRequest({}, { mcpReq: { signal: new AbortController().signal } })).toEqual({
    roots: [{ uri: "file:///c" }],
  });
  await first.dispose();
  await second.dispose();
  await third.dispose();
});

it("does not restore a released roots owner after a failed replacement", async () => {
  let rootsRequest:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  const notifications: Array<PromiseWithResolvers<void>> = [];
  const entered = Promise.withResolvers<void>();
  const failure = new Error("replacement failed");
  const client = makeClient({
    notification: () => {
      const pending = Promise.withResolvers<void>();
      notifications.push(pending);
      entered.resolve();
      return pending.promise;
    },
    setRequestHandler: ((
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsRequest = handler;
    }) as NonNullable<ProjectMcpClient["setRequestHandler"]>,
  });
  const shared = connection(client, "legacy");
  const first = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-released-a",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///released" }] }) },
  });
  const second = new ProjectMcpBroker({
    connection: shared,
    serverId,
    providerSessionId: "roots-released-b",
    downstreamProtocolEra: "modern",
    handlers: { onRootsRequest: () => ({ roots: [{ uri: "file:///failed" }] }) },
  });
  if (!rootsRequest) throw new Error("roots handler was not installed");
  const firstNotification = first.notifyRootsListChanged();
  await entered.promise;
  notifications[0]!.resolve();
  await firstNotification;
  const failed = second.notifyRootsListChanged();
  while (notifications.length < 2) await Promise.resolve();
  await first.dispose();
  notifications[1]!.reject(failure);
  await expect(failed).rejects.toBe(failure);
  await expect(
    Promise.resolve().then(() =>
      rootsRequest!({}, { mcpReq: { signal: new AbortController().signal } }),
    ),
  ).rejects.toMatchObject({ code: -32601 });
  await second.dispose();
});
