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

it("relays list-change notifications through the semantic handler surface", async () => {
  let toolsChanged: unknown;
  let registered: (() => void | Promise<void>) | undefined;
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
  await registered?.();
  expect(toolsChanged).toEqual({
    tools: [{ name: "new-tool", inputSchema: { type: "object" } }],
  });
});
