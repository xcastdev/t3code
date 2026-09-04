import { McpServerId, ProjectMcpCredentialId, type ProjectMcpTransport } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  makeProjectMcpTransport,
  type ProjectMcpTransportConstructors,
} from "./ProjectMcpTransport.ts";

const constructors: ProjectMcpTransportConstructors = {
  streamableHttp: (url, options) => ({
    kind: "streamable-http",
    url: String(url),
    options,
  }),
  legacySse: (url, options) => ({
    kind: "legacy-sse",
    url: String(url),
    options,
  }),
  stdio: (options) => ({ kind: "stdio", options }),
};

const tokenId = ProjectMcpCredentialId.make("11111111-1111-4111-8111-111111111111");
const secretValues = new Map<string, string>([[tokenId, "secret-token"]]);
const resolveSecret = (ref: string) => secretValues.get(ref);

it("creates a stdio transport with resolved environment values", () => {
  const transport: ProjectMcpTransport = {
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
    cwd: "/workspace",
    env: [
      {
        name: "TOKEN" as never,
        credential: { id: tokenId, name: "token" },
      },
    ],
  };

  expect(
    makeProjectMcpTransport({
      serverId: McpServerId.make("mcp-stdio"),
      transport,
      resolveSecret,
      constructors,
    }),
  ).toEqual({
    kind: "stdio",
    options: {
      command: "node",
      args: ["server.mjs"],
      cwd: "/workspace",
      env: { TOKEN: "secret-token" },
      stderr: "pipe",
    },
  });
});

it("creates Streamable HTTP and legacy SSE transports with request headers", () => {
  const header = [
    {
      name: "Authorization" as never,
      credential: { id: tokenId, name: "token" },
    },
  ];
  const streamable = makeProjectMcpTransport({
    serverId: McpServerId.make("mcp-http"),
    transport: {
      type: "streamable-http",
      url: "https://example.test/mcp",
      headers: header,
      authorization: { type: "none" },
    },
    resolveSecret,
    constructors,
  });
  const legacy = makeProjectMcpTransport({
    serverId: McpServerId.make("mcp-sse"),
    transport: {
      type: "legacy-sse",
      url: "https://example.test/sse",
      headers: header,
      authorization: { type: "none" },
    },
    resolveSecret,
    constructors,
  });

  expect(streamable).toEqual({
    kind: "streamable-http",
    url: "https://example.test/mcp",
    options: { requestInit: { headers: { Authorization: "secret-token" } } },
  });
  expect(legacy).toEqual({
    kind: "legacy-sse",
    url: "https://example.test/sse",
    options: {
      eventSourceInit: {},
      requestInit: { headers: { Authorization: "secret-token" } },
    },
  });
});

it("fails closed when a configured secret reference cannot be resolved", () => {
  expect(() =>
    makeProjectMcpTransport({
      serverId: McpServerId.make("mcp-missing-secret"),
      transport: {
        type: "stdio",
        command: "node",
        args: [],
        env: [
          {
            name: "TOKEN" as never,
            credential: {
              id: ProjectMcpCredentialId.make("22222222-2222-4222-8222-222222222222"),
              name: "missing",
            },
          },
        ],
      },
      resolveSecret,
      constructors,
    }),
  ).toThrow("MCP secret is unavailable");
});
