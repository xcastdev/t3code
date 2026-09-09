import { EnvironmentId, McpServerId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ProjectMcpProxyHttpServer from "./ProjectMcpProxyHttpServer.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["project"]),
  issuedAt: 1,
};

const makeRequest = (url: string, headers?: Record<string, string>, body?: unknown) =>
  HttpServerRequest.fromWeb(
    new Request(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const makeSessionRegistry = (
  scope: McpInvocationContext.McpInvocationScope | undefined,
): McpSessionRegistry.McpSessionRegistryShape => ({
  issue: vi.fn(),
  resolve: vi.fn(() => Effect.succeed(scope)),
  touch: vi.fn(),
  revokeProviderSession: vi.fn(),
  revokeThread: vi.fn(),
  revokeAll: Effect.void,
});

const makeProxyRegistry = (
  response: Response,
  resolved = true,
): ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape => ({
  registerSession: vi.fn(),
  resolve: vi.fn(() =>
    Effect.succeed(
      resolved
        ? ({
            server: {
              id: McpServerId.make("server-1"),
              name: "Server",
              transport: {
                type: "streamable-http",
                url: "https://upstream.example.test/rpc",
                headers: [],
                authorization: { type: "none" },
              },
            },
            threadId: invocation.threadId,
          } as never)
        : undefined,
    ),
  ),
  handle: vi.fn(() => Effect.succeed(response)),
  revokeProviderSession: vi.fn(),
  revokeThread: vi.fn(),
  revokeServer: vi.fn(),
  revokeOAuthStorage: vi.fn(),
  revokeAll: Effect.void,
});

const runRequest = (
  request: HttpServerRequest.HttpServerRequest,
  sessions: McpSessionRegistry.McpSessionRegistryShape,
  proxy: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape,
) =>
  ProjectMcpProxyHttpServer.handleProjectMcpProxyRequest(request).pipe(
    Effect.provideService(McpSessionRegistry.McpSessionRegistry, sessions),
    Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, proxy),
  );

it.effect("rejects missing and invalid bearer credentials before dispatch", () =>
  Effect.gen(function* () {
    const proxy = makeProxyRegistry(new Response("should-not-dispatch"));
    const sessions = makeSessionRegistry(undefined);
    const response = yield* runRequest(
      makeRequest("http://127.0.0.1/mcp/project/opaque", undefined, { jsonrpc: "2.0" }),
      sessions,
      proxy,
    );

    expect(response.status).toBe(401);
    expect(proxy.handle).not.toHaveBeenCalled();
  }),
);

it.effect("validates the session before forwarding the opaque endpoint", () =>
  Effect.gen(function* () {
    const proxy = makeProxyRegistry(new Response('{"ok":true}', { status: 200 }));
    const sessions = makeSessionRegistry(invocation);
    const response = yield* runRequest(
      makeRequest(
        "http://127.0.0.1/mcp/project/opaque-handle",
        { authorization: "Bearer session-token" },
        { jsonrpc: "2.0", id: 1, method: "ping" },
      ),
      sessions,
      proxy,
    );

    expect(response.status).toBe(200);
    expect(proxy.handle).toHaveBeenCalledWith(
      invocation.providerSessionId,
      "opaque-handle",
      expect.any(Request),
    );
  }),
);

it.effect("maps a revoked proxy endpoint to a redacted authorization response", () =>
  Effect.gen(function* () {
    const proxy = makeProxyRegistry(new Response(null, { status: 401 }), false);
    const sessions = makeSessionRegistry(invocation);
    const response = yield* runRequest(
      makeRequest("http://127.0.0.1/mcp/project/opaque", { authorization: "Bearer token" }),
      sessions,
      proxy,
    );

    expect(response.status).toBe(404);
  }),
);
