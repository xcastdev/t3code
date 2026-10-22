import { expect, it } from "@effect/vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import { connectProjectMcp } from "./ProjectMcpConnection.ts";

it.live("stdio runs on the host and closes the exact SDK-owned child", () =>
  Effect.gen(function* () {
    const source = `import {Server} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))}; import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))}; import {ListToolsRequestSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))}; const server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'host_tool',inputSchema:{type:'object'}}]}));await server.connect(new StdioServerTransport());`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "-e", source],
      stderr: "ignore",
    });
    const client = yield* Effect.acquireRelease(
      Effect.promise(() => connectProjectMcp(transport)),
      (value) => Effect.promise(() => value.close()),
    );
    expect(transport.pid).toBeGreaterThan(0);
    const tools = yield* Effect.promise(() => client.listTools());
    expect(tools.tools.map((tool) => tool.name)).toEqual(["host_tool"]);
  }),
);
it.live("native HTTP transport handshakes and forwards tools without exposing headers", () =>
  Effect.gen(function* () {
    const servers: Server[] = [];
    let header: string | null = null;
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.all(servers.map((server) => server.close()));
      }),
    );
    const transport = new StreamableHTTPClientTransport(new URL("http://fixture.invalid/mcp"), {
      requestInit: { headers: { authorization: "Bearer fixture-private" } },
      fetch: async (url, init) => {
        const request = new Request(url, init);
        header = request.headers.get("authorization");
        const wire = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        const server = new Server(
          { name: "fixture", version: "1" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [{ name: "remote_tool", inputSchema: { type: "object" } }],
        }));
        servers.push(server);
        await server.connect(wire);
        return wire.handleRequest(request);
      },
    });
    const client = yield* Effect.acquireRelease(
      Effect.promise(() => connectProjectMcp(transport)),
      (value) => Effect.promise(() => value.close()),
    );
    const tools = yield* Effect.promise(() => client.listTools());
    expect(tools.tools.map((tool) => tool.name)).toEqual(["remote_tool"]);
    expect(header).toBe("Bearer fixture-private");
  }),
);
