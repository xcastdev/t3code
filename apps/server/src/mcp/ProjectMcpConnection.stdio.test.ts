import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { McpServerId } from "@t3tools/contracts";
import {
  connectProjectMcpServer,
  projectMcpConnectionCoordinator,
} from "./ProjectMcpConnection.ts";
import type { ProjectMcpConnection } from "./ProjectMcpConnection.ts";
import { ProjectMcpBroker } from "./ProjectMcpBroker.ts";
import { ProtocolErrorCode } from "@modelcontextprotocol/client";

it("owns modern subscriptions once and delivers updates until unsubscribe or close", async ({
  onTestFinished,
}) => {
  const serverId = McpServerId.make("modern-stdio");
  const connection = await connectProjectMcpServer({
    serverId,
    transport: {
      type: "stdio",
      command: process.execPath,
      env: [],
      args: [
        NodeURL.fileURLToPath(new URL("./ProjectMcpConnection.stdio.fixture.mjs", import.meta.url)),
      ],
    },
    resolveSecret: () => undefined,
  });
  onTestFinished(() => connection.close());
  const first = new ProjectMcpBroker({ connection, serverId, providerSessionId: "first" });
  const second = new ProjectMcpBroker({ connection, serverId, providerSessionId: "second" });
  const a = Promise.withResolvers<void>();
  const b = Promise.withResolvers<void>();
  let firstDeliveries = 0;
  const disposeFirst = first.setHandlers({
    onToolsChanged: () => {
      firstDeliveries += 1;
      a.resolve();
    },
  });
  second.setHandlers({ onToolsChanged: () => b.resolve() });
  try {
    await first.callTool({ name: "emit" });
    await Promise.all([a.promise, b.promise]);
    expect(connection.protocolEra).toBe("modern");
    expect((await first.callTool({ name: "subscriptions" })).content).toEqual([
      { type: "text", text: '{"opened":1,"active":1}' },
    ]);
    const prompts = Promise.withResolvers<void>();
    const resources = Promise.withResolvers<void>();
    let updated = Promise.withResolvers<void>();
    let updates = 0;
    second.setHandlers({
      onPromptsChanged: () => prompts.resolve(),
      onResourcesChanged: () => resources.resolve(),
      onResourceUpdated: (uri) => {
        expect(uri).toBe("file:///fixture");
        updates += 1;
        updated.resolve();
      },
    });
    await Promise.all([
      first.subscribeResource({ uri: "file:///fixture" }),
      second.subscribeResource({ uri: "file:///fixture" }),
    ]);
    expect((await first.callTool({ name: "subscriptions" })).content).toEqual([
      { type: "text", text: '{"opened":2,"active":2}' },
    ]);
    disposeFirst();
    await first.callTool({ name: "emit" });
    await Promise.all([prompts.promise, resources.promise, updated.promise]);
    expect(firstDeliveries).toBe(1);
    await first.unsubscribeResource({ uri: "file:///fixture" });
    updated = Promise.withResolvers<void>();
    await first.callTool({ name: "emit" });
    await updated.promise;
    expect(updates).toBe(2);
    await second.unsubscribeResource({ uri: "file:///fixture" });
    expect((await first.callTool({ name: "subscriptions" })).content).toEqual([
      { type: "text", text: '{"opened":2,"active":1}' },
    ]);
    await first.callTool({ name: "emit" });
    await first.callTool({ name: "subscriptions" });
    expect(updates).toBe(2);
    await connection.close();
    await expect(first.subscribeResource({ uri: "file:///fixture" })).rejects.toThrow("closed");
  } finally {
    await connection.close();
  }
});

it("releases roots ownership on replacement and connection close", async () => {
  let rootsRequest:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  const client = {
    connect: async () => undefined,
    close: async () => undefined,
    setRequestHandler: (
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsRequest = handler;
    },
  };
  const connection = {
    client,
    transport: { type: "stdio", command: "fixture", args: [], env: [] } as const,
    protocolEra: "legacy" as const,
    negotiatedProtocolVersion: "2025-11-25",
    discoverResult: undefined,
    close: async () => undefined,
  };
  const coordinator = projectMcpConnectionCoordinator(
    connection as unknown as ProjectMcpConnection,
  );
  if (!rootsRequest) throw new Error("roots request handler was not registered");
  const first = {};
  const second = {};
  coordinator.setRootsOwner(first, () => ({ roots: [{ uri: "file:///first" }] }));
  coordinator.setRootsOwner(second, () => ({ roots: [{ uri: "file:///second" }] }));
  const context = { mcpReq: { signal: new AbortController().signal } };
  expect(await rootsRequest({ method: "roots/list" }, context)).toEqual({
    roots: [{ uri: "file:///second" }],
  });
  coordinator.releaseRootsOwner(first);
  expect(await rootsRequest({ method: "roots/list" }, context)).toEqual({
    roots: [{ uri: "file:///second" }],
  });
  coordinator.releaseRootsOwner(second);
  await expect(
    Promise.resolve().then(() => rootsRequest!({ method: "roots/list" }, context)),
  ).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
  coordinator.setRootsOwner(first, () => ({ roots: [{ uri: "file:///first" }] }));
  await coordinator.close();
  await expect(
    Promise.resolve().then(() => rootsRequest!({ method: "roots/list" }, context)),
  ).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
});
