import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { McpServerId } from "@t3tools/contracts";
import { connectProjectMcpServer } from "./ProjectMcpConnection.ts";
import { ProjectMcpBroker } from "./ProjectMcpBroker.ts";

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
