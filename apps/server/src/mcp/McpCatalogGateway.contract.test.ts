import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { expect, it } from "@effect/vitest";

type CatalogTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: { readonly type: "object" };
};

const namespacedTool = (serverId: string, name: string): string =>
  `mcp_${serverId.replaceAll("-", "")}__${name}`;

const openEmptyGateway = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "t3-catalog-fixture", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
  );
  let tools: CatalogTool[] = [];
  server.setRequestHandler("tools/list", async () => ({ tools }));
  await server.connect(serverTransport);

  const client = new Client(
    { name: "t3-catalog-contract", version: "1" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const notifications: string[] = [];
  const waits: Array<() => void> = [];
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications.push("notifications/tools/list_changed");
    waits.shift()?.();
  });
  await client.connect(clientTransport);

  return {
    client,
    async apply(next: CatalogTool[]) {
      tools = next;
      await server.sendToolListChanged();
    },
    async takeNotification() {
      if (notifications.shift()) return;
      await new Promise<void>((resolve) => waits.push(resolve));
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
};

it("publishes catalog list changes without reconnecting", async () => {
  const session = await openEmptyGateway();
  try {
    expect(await session.client.listTools()).toEqual({ tools: [] });

    const weatherTool = {
      name: namespacedTool("weather-server", "forecast"),
      description: "Current weather",
      inputSchema: { type: "object" as const },
    };
    await session.apply([weatherTool]);
    await session.takeNotification();
    expect((await session.client.listTools()).tools).toEqual([weatherTool]);

    const changedTool = { ...weatherTool, description: "Seven-day forecast" };
    await session.apply([changedTool]);
    await session.takeNotification();
    expect((await session.client.listTools()).tools).toEqual([changedTool]);

    await session.apply([]);
    await session.takeNotification();
    expect(await session.client.listTools()).toEqual({ tools: [] });
  } finally {
    await session.close();
  }
});
