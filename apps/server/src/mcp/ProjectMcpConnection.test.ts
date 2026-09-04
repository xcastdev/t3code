import { McpServerId, type ProjectMcpTransport } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  Client,
  SdkErrorCode,
  SdkHttpError,
  type ClientOptions,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  connectProjectMcpServer,
  type ProjectMcpClient,
  type ProjectMcpConnectionDependencies,
} from "./ProjectMcpConnection.ts";

const modern: ProjectMcpTransport = {
  type: "streamable-http",
  url: "https://example.test/mcp",
  headers: [],
  authorization: { type: "none" },
};

it("falls back from modern Streamable HTTP to legacy SSE only when the endpoint rejects it", async () => {
  const connected: string[] = [];
  const transports: string[] = [];
  const closedTransports: string[] = [];
  let closedClients = 0;
  const clients: ProjectMcpClient[] = [];
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: (options) => {
      const client: ProjectMcpClient = {
        connect: async (transport) => {
          connected.push(String((transport as { kind: string }).kind));
          if (connected.length === 1) {
            throw new SdkHttpError(
              SdkErrorCode.ClientHttpFailedToOpenStream,
              "method not allowed",
              {
                status: 405,
              },
            );
          }
        },
        close: async () => {
          closedClients += 1;
        },
        getProtocolEra: () => "legacy",
        getNegotiatedProtocolVersion: () => "2025-11-25",
        getDiscoverResult: () => undefined,
      };
      clients.push(client);
      return client;
    },
    createTransport: ({ transport }) => {
      transports.push(transport.type);
      return {
        kind: transport.type,
        close: async () => {
          closedTransports.push(transport.type);
        },
      };
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
  expect(clients).toHaveLength(2);
  expect(closedTransports).toEqual(["streamable-http"]);
  expect(connection.protocolEra).toBe("legacy");
  expect(connection.negotiatedProtocolVersion).toBe("2025-11-25");
  await connection.close();
  expect(closedClients).toBe(2);
  expect(closedTransports).toEqual(["streamable-http", "legacy-sse"]);
});

it("uses a fresh client and legacy transport for a 400 fallback", async () => {
  const options: ClientOptions[] = [];
  const clients: ProjectMcpClient[] = [];
  const connected: string[] = [];
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: (clientOptions) => {
      options.push(clientOptions);
      const client: ProjectMcpClient = {
        connect: async (transport) => {
          connected.push(String((transport as { kind: string }).kind));
          if (connected.length === 1) {
            throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, "bad request", {
              status: 400,
            });
          }
        },
        close: async () => undefined,
      };
      clients.push(client);
      return client;
    },
    createTransport: ({ transport }) => ({ kind: transport.type, close: async () => undefined }),
  };

  const connection = await connectProjectMcpServer({
    serverId: McpServerId.make("mcp-http-400"),
    transport: modern,
    resolveSecret: () => undefined,
    dependencies,
  });

  expect(options).toEqual([
    { versionNegotiation: { mode: "auto" }, inputRequired: { autoFulfill: false, maxRounds: 10 } },
    {
      versionNegotiation: { mode: "legacy" },
      inputRequired: { autoFulfill: false, maxRounds: 10 },
    },
  ]);
  expect(clients[0]).not.toBe(clients[1]);
  expect(connected).toEqual(["streamable-http", "legacy-sse"]);
  await connection.close();
});

it("uses explicit legacy negotiation for a legacy SSE transport", async () => {
  let options: ClientOptions | undefined;
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: (clientOptions) => {
      options = clientOptions;
      return {
        connect: async () => undefined,
        close: async () => undefined,
      };
    },
    createTransport: ({ transport }) => ({ kind: transport.type }),
  };

  const connection = await connectProjectMcpServer({
    serverId: McpServerId.make("mcp-explicit-sse"),
    transport: {
      type: "legacy-sse",
      url: "https://example.test/sse",
      headers: [],
      authorization: { type: "none" },
    },
    resolveSecret: () => undefined,
    dependencies,
  });

  expect(options).toEqual({
    versionNegotiation: { mode: "legacy" },
    inputRequired: { autoFulfill: false, maxRounds: 10 },
  });
  await connection.close();
});

it("does not close an SDK-owned transport twice", async () => {
  let transportCloseCount = 0;
  let clientCloseCount = 0;
  let attached: { close: () => Promise<void> } | undefined;
  const client: ProjectMcpClient = {
    connect: async (transport) => {
      attached = transport as { close: () => Promise<void> };
      (client as { transport?: unknown }).transport = transport;
    },
    close: async () => {
      clientCloseCount += 1;
      await attached?.close();
    },
  };
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: () => client,
    createTransport: () => ({
      close: async () => {
        transportCloseCount += 1;
      },
    }),
  };

  const connection = await connectProjectMcpServer({
    serverId: McpServerId.make("mcp-owned-transport"),
    transport: modern,
    resolveSecret: () => undefined,
    dependencies,
  });
  await connection.close();

  expect(clientCloseCount).toBe(1);
  expect(transportCloseCount).toBe(1);
});

it("constructs each v2 client with automatic negotiation and manual input handling", async () => {
  const options: ClientOptions[] = [];
  const client: ProjectMcpClient = {
    connect: async (transport) => {
      expect(transport).toEqual({ kind: "streamable-http" });
    },
    close: async () => undefined,
    getProtocolEra: () => "modern",
    getNegotiatedProtocolVersion: () => "2026-07-28",
    getDiscoverResult: () => ({
      supportedVersions: ["2026-07-28"],
      capabilities: {},
    }),
  };
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: (clientOptions) => {
      options.push(clientOptions);
      return client;
    },
    createTransport: ({ transport }) => {
      return { kind: transport.type };
    },
  };

  const connection = await connectProjectMcpServer({
    serverId: McpServerId.make("mcp-http"),
    transport: modern,
    resolveSecret: () => undefined,
    dependencies,
  });

  expect(options).toEqual([
    {
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false, maxRounds: 10 },
    },
  ]);
  expect(connection.protocolEra).toBe("modern");
  expect(connection.negotiatedProtocolVersion).toBe("2026-07-28");
  expect(connection.discoverResult).toEqual({
    supportedVersions: ["2026-07-28"],
    capabilities: {},
  });
  await connection.close();
});

it("negotiates the current era with a real v2 stdio fixture and closes its child", async () => {
  const fixture = [
    'let buffer = ""',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.on("data", chunk => {',
    "  buffer += chunk",
    "  let newline",
    '  while ((newline = buffer.indexOf("\\n")) >= 0) {',
    "    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)",
    "    if (!line) continue",
    "    const request = JSON.parse(line)",
    '    if (request.method === "server/discover") {',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { supportedVersions: ["2026-07-28"], capabilities: {} } }) + "\\n")',
    '    } else if (request.method === "initialize") {',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2026-07-28", capabilities: {}, serverInfo: { name: "stdio-fixture", version: "1" } } }) + "\\n")',
    "    }",
    "  }",
    "})",
  ].join(";");
  let stdio: StdioClientTransport | undefined;
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: (options) => {
      const client = new Client({ name: "t3-test", version: "1" }, options);
      return {
        connect: (transport) => client.connect(transport as Transport),
        close: () => client.close(),
        getProtocolEra: () => client.getProtocolEra(),
        getNegotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
        getDiscoverResult: () => client.getDiscoverResult(),
      };
    },
    createTransport: () => {
      stdio = new StdioClientTransport({
        command: process.execPath,
        args: ["-e", fixture],
        stderr: "pipe",
      });
      return stdio;
    },
  };

  const connection = await connectProjectMcpServer({
    serverId: McpServerId.make("mcp-stdio"),
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["-e", fixture],
      env: [],
    },
    resolveSecret: () => undefined,
    dependencies,
  });

  expect(connection.protocolEra).toBe("modern");
  expect(connection.negotiatedProtocolVersion).toBe("2026-07-28");
  await connection.close();
  expect(stdio?.pid).toBeNull();
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

it("closes a client when transport construction fails", async () => {
  let closeCount = 0;
  const dependencies: ProjectMcpConnectionDependencies = {
    createClient: () => ({
      connect: async () => undefined,
      close: async () => {
        closeCount += 1;
      },
    }),
    createTransport: () => {
      throw new Error("secret unavailable");
    },
  };

  await expect(
    connectProjectMcpServer({
      serverId: McpServerId.make("mcp-http"),
      transport: modern,
      resolveSecret: () => undefined,
      dependencies,
    }),
  ).rejects.toThrow("secret unavailable");
  expect(closeCount).toBe(1);
});

it.each([
  ["forbidden", { data: { status: 403 } }],
  ["rate limited", { data: { status: 429 } }],
  ["server failure", { data: { status: 503 } }],
  ["timeout", { code: "RequestTimeout" }],
])("does not treat a %s as legacy-era evidence", async (_name, error) => {
  let attempts = 0;
  const client: ProjectMcpClient = {
    connect: async () => {
      attempts += 1;
      throw error;
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
  ).rejects.toEqual(error);
  expect(attempts).toBe(1);
});
