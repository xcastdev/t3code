// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  Server as McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

type JsonRecord = Record<string, unknown>;

interface RegisteredMcpClient {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

export interface OpenCodeExternalMcpFixture {
  readonly openCodeUrl: string;
  readonly mcpUrl: string;
  readonly token: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly status: Readonly<Record<string, { readonly status: string }>>;
  readonly registeredClients: ReadonlyMap<string, RegisteredMcpClient>;
  readonly invokeRegisteredTool: (name: string) => Promise<unknown>;
  readonly revokeToken: () => void;
  readonly probeWithRevokedToken: () => Promise<Response>;
  readonly close: () => Promise<void>;
}

const readBody = (request: NodeHttp.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const writeJson = (response: NodeHttp.ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
};

const listen = (server: NodeHttp.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Fixture server did not expose a TCP address."));
      } else {
        resolve(address.port);
      }
    });
  });

const closeServer = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const createMcpHandler = (token: string) => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();

  const handle = async (request: Request): Promise<Response> => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const sessionId = request.headers.get("mcp-session-id");
    let transport = sessionId === null ? undefined : transports.get(sessionId);
    let server: McpServer | undefined;
    if (transport === undefined) {
      server = new McpServer({ name: "external-mcp-fixture", version: "1" });
      server.registerCapabilities({ tools: {} });
      server.setRequestHandler("tools/list", () => ({
        tools: [
          {
            name: "sentinel",
            description: "Returns the external MCP fixture sentinel.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
      server.setRequestHandler("tools/call", (toolRequest) => {
        if (toolRequest.params.name !== "sentinel") {
          return Promise.resolve({
            content: [{ type: "text" as const, text: "Unknown fixture tool." }],
            isError: true,
          });
        }
        return Promise.resolve({
          content: [{ type: "text" as const, text: "external-mcp-sentinel" }],
        });
      });
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => NodeCrypto.randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          if (transport !== undefined) transports.set(initializedSessionId, transport);
        },
        onsessionclosed: (closedSessionId) => {
          transports.delete(closedSessionId);
          if (server !== undefined) servers.delete(server);
        },
      });
      servers.add(server);
      await server.connect(transport);
    }
    const response = await transport.handleRequest(request);
    if (transport.sessionId !== undefined) transports.set(transport.sessionId, transport);
    return response;
  };

  const close = async () => {
    await Promise.allSettled([
      ...[...transports.values()].map((transport) => transport.close()),
      ...[...servers].map((server) => server.close()),
    ]);
  };

  return { handle, close };
};

const toWebRequest = async (
  request: NodeHttp.IncomingMessage,
  baseUrl: string,
): Promise<Request> => {
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  return new Request(new URL(request.url ?? "/", baseUrl).toString(), {
    method: request.method ?? "GET",
    headers: Object.entries(request.headers).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
    ),
    ...(body === undefined ? {} : { body }),
  });
};

const writeWebResponse = async (
  response: NodeHttp.ServerResponse,
  webResponse: Response,
): Promise<void> => {
  const body = Buffer.from(await webResponse.arrayBuffer());
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(webResponse.status, headers);
  response.end(body);
};

export const startOpenCodeExternalMcpFixture = async (): Promise<OpenCodeExternalMcpFixture> => {
  const token = "fixture-mcp-token";
  let tokenActive = true;
  const config: Record<string, unknown> = {};
  const status: Record<string, { status: string }> = {};
  const registeredClients = new Map<string, RegisteredMcpClient>();

  const mcpHandler = createMcpHandler(token);
  const mcpServer = NodeHttp.createServer(async (request, response) => {
    if (!tokenActive) {
      writeJson(response, 401, { error: "revoked" });
      return;
    }
    try {
      const webResponse = await mcpHandler.handle(await toWebRequest(request, mcpBaseUrl));
      await writeWebResponse(response, webResponse);
    } catch (cause) {
      writeJson(response, 500, { error: String(cause) });
    }
  });
  const mcpPort = await listen(mcpServer);
  const mcpBaseUrl = `http://127.0.0.1:${mcpPort}`;
  const mcpUrl = `${mcpBaseUrl}/mcp`;

  const openCodeServer = NodeHttp.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", openCodeBaseUrl);
    const headerDirectory = request.headers["x-opencode-directory"];
    const encodedDirectory = Array.isArray(headerDirectory) ? headerDirectory[0] : headerDirectory;
    const directory =
      url.searchParams.get("directory") ??
      (encodedDirectory === undefined ? null : decodeURIComponent(encodedDirectory));
    if (directory === null && url.pathname !== "/event") {
      writeJson(response, 400, { error: "directory is required" });
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/config") {
        writeJson(response, 200, { mcp: config });
        return;
      }
      if (request.method === "GET" && url.pathname === "/mcp") {
        writeJson(response, 200, status);
        return;
      }
      if (request.method === "POST" && url.pathname === "/mcp") {
        const body = JSON.parse(await readBody(request)) as JsonRecord;
        const name = String(body.name);
        const mcpConfig = body.config as JsonRecord;
        config[name] = mcpConfig;
        const headers = (mcpConfig.headers ?? {}) as Record<string, string>;
        const transport = new StreamableHTTPClientTransport(new URL(String(mcpConfig.url)), {
          fetch: (input, init) => {
            const requestHeaders = new Headers(init?.headers);
            for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
            return globalThis.fetch(input, { ...init, headers: requestHeaders });
          },
        });
        const client = new Client({ name: "opencode-external-fixture", version: "1" });
        try {
          await client.connect(transport);
          registeredClients.set(name, { client, transport });
          status[name] = { status: "connected" };
        } catch {
          status[name] = { status: "failed" };
          await transport.close().catch(() => undefined);
        }
        writeJson(response, 200, { [name]: status[name] });
        return;
      }
      const disconnectMatch = url.pathname.match(/^\/mcp\/([^/]+)\/disconnect$/);
      if (request.method === "POST" && disconnectMatch !== null) {
        const name = decodeURIComponent(disconnectMatch[1]!);
        const registered = registeredClients.get(name);
        registeredClients.delete(name);
        if (registered !== undefined) {
          await registered.client.close().catch(() => undefined);
          await registered.transport.close().catch(() => undefined);
        }
        status[name] = { status: "disabled" };
        writeJson(response, 200, {});
        return;
      }
      if (request.method === "POST" && url.pathname === "/session") {
        writeJson(response, 200, {
          id: "fixture-session",
          directory,
          title: "External MCP fixture session",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/event") {
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        // The fixture only needs the initial connection event. Closing the
        // stream makes the adapter's scope deterministic after startup.
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/permission") {
        writeJson(response, 200, []);
        return;
      }
      if (request.method === "GET" && url.pathname === "/question") {
        writeJson(response, 200, []);
        return;
      }
      writeJson(response, 404, { error: "not found" });
    } catch (cause) {
      writeJson(response, 500, { error: String(cause) });
    }
  });
  const openCodePort = await listen(openCodeServer);
  const openCodeBaseUrl = `http://127.0.0.1:${openCodePort}`;

  return {
    openCodeUrl: openCodeBaseUrl,
    mcpUrl,
    token,
    config,
    status,
    registeredClients,
    invokeRegisteredTool: async (name) => {
      const registered = registeredClients.get(name);
      if (registered === undefined) throw new Error(`No registered MCP client named ${name}.`);
      return registered.client.callTool({ name: "sentinel", arguments: {} });
    },
    revokeToken: () => {
      tokenActive = false;
    },
    probeWithRevokedToken: () =>
      globalThis.fetch(mcpUrl, { headers: { Authorization: `Bearer ${token}` } }),
    close: async () => {
      await Promise.allSettled(
        [...registeredClients.values()].map(async ({ client, transport }) => {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        }),
      );
      await Promise.all([mcpHandler.close(), closeServer(openCodeServer), closeServer(mcpServer)]);
    },
  };
};
