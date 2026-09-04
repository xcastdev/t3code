import { McpServerId, type ProjectMcpTransport } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  connectProjectMcpServer,
  type ProjectMcpClient,
  type ProjectMcpConnectionDependencies,
} from "./ProjectMcpConnection.ts";

const modern: ProjectMcpTransport = {
  type: "streamable-http",
  url: "https://example.test/mcp",
  headers: [],
};

it("falls back from modern Streamable HTTP to legacy SSE only when the endpoint rejects it", async () => {
  const connected: string[] = [];
  const transports: string[] = [];
  const client: ProjectMcpClient = {
    connect: async (transport) => {
      connected.push(String((transport as { kind: string }).kind));
      if (connected.length === 1) throw { code: 405 };
    },
    close: async () => undefined,
  };
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: () => client,
    createTransport: ({ transport }) => {
      transports.push(transport.type);
      return { kind: transport.type };
    },
  };

  const connection = await connectProjectMcpServer({
    serverId: McpServerId.make("mcp-http"),
    transport: modern,
    resolveSecret: () => undefined,
    dependencies,
  });

  expect(transports).toEqual(["streamable-http", "legacy-sse"]);
  expect(connected).toEqual(["streamable-http", "legacy-sse"]);
  await connection.close();
});

it("does not hide a modern transport authentication failure behind legacy fallback", async () => {
  const client: ProjectMcpClient = {
    connect: async () => {
      throw { code: 401 };
    },
    close: async () => undefined,
  };
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: () => client,
    createTransport: ({ transport }) => ({ kind: transport.type }),
  };

  await expect(
    connectProjectMcpServer({
      serverId: McpServerId.make("mcp-http"),
      transport: modern,
      resolveSecret: () => undefined,
      dependencies,
    }),
  ).rejects.toEqual({ code: 401 });
});
