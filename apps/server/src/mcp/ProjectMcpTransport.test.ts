import { McpServerId, ProjectMcpCredentialId, type ProjectMcpTransport } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

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
const oauthProvider = {
  redirectUrl: undefined,
  clientMetadata: { redirect_uris: [] },
  clientInformation: () => undefined,
  tokens: () => undefined,
  saveTokens: () => undefined,
  redirectToAuthorization: () => undefined,
  saveCodeVerifier: () => undefined,
  codeVerifier: () => "verifier",
} satisfies OAuthClientProvider;

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
      env: { ...getDefaultEnvironment(), TOKEN: "secret-token" },
      stderr: "ignore",
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

it("lets configured stdio variables override the safe inherited environment", () => {
  const transport: ProjectMcpTransport = {
    type: "stdio",
    command: "node",
    args: [],
    env: [
      {
        name: "PATH" as never,
        credential: { id: tokenId, name: "path" },
      },
    ],
  };

  expect(
    makeProjectMcpTransport({
      serverId: McpServerId.make("mcp-stdio"),
      transport,
      resolveSecret: resolveSecret,
      constructors,
    }),
  ).toEqual({
    kind: "stdio",
    options: {
      command: "node",
      args: [],
      env: { ...getDefaultEnvironment(), PATH: "secret-token" },
      stderr: "ignore",
    },
  });
});

it("starts a noisy stdio child without retaining its stderr", async () => {
  const transport = makeProjectMcpTransport({
    serverId: McpServerId.make("mcp-noisy-stdio"),
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [
        "-e",
        [
          'process.stderr.write("secret-value:" + "x".repeat(4 * 1024 * 1024), () => {',
          '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n")',
          "})",
        ].join(""),
      ],
      env: [],
    },
    resolveSecret,
  }) as StdioClientTransport;
  const ready = new Promise<void>((resolve) => {
    transport.onmessage = (message) => {
      if ("method" in message && message.method === "ready") resolve();
    };
  });

  await transport.start();
  expect(transport.stderr).toBeNull();
  await ready;
  await transport.close();
});

it("passes an OAuth provider to both HTTP transport kinds without copying bearer headers", () => {
  expect(
    makeProjectMcpTransport({
      serverId: McpServerId.make("mcp-oauth"),
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: [],
        authorization: { type: "oauth", registration: { type: "automatic" } },
      },
      resolveSecret,
      oauthProvider,
      constructors,
    }),
  ).toEqual({
    kind: "streamable-http",
    url: "https://example.test/mcp",
    options: { requestInit: { headers: {} }, authProvider: oauthProvider },
  });
});

it("rejects a competing Authorization header when OAuth is selected", () => {
  expect(() =>
    makeProjectMcpTransport({
      serverId: McpServerId.make("mcp-oauth-header"),
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: [
          {
            name: "Authorization" as never,
            credential: { id: tokenId, name: "bearer" },
          },
        ],
        authorization: { type: "oauth", registration: { type: "automatic" } },
      },
      resolveSecret,
      oauthProvider,
      constructors,
    }),
  ).toThrow("Authorization header");
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
