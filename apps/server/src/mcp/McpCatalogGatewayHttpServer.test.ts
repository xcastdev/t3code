import { expect, it, vi } from "@effect/vitest";
import { McpCatalogSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http";

import * as McpCatalogGateway from "./McpCatalogGateway.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { handleMcpCatalogGatewayRequest } from "./McpCatalogGatewayHttpServer.ts";

const sessions = (
  scope: McpSessionRegistry.McpSessionRegistryShape["resolve"],
): McpSessionRegistry.McpSessionRegistryShape => ({
  issue: vi.fn(),
  resolve: scope,
  touch: vi.fn(),
  revokeProviderSession: vi.fn(),
  revokeThread: vi.fn(),
  revokeAll: Effect.void,
});

const gateway = (authorized: boolean): McpCatalogGateway.McpCatalogGatewayShape => ({
  registerCatalogSession: vi.fn(),
  applyCatalogRevision: vi.fn(),
  resolveCatalogSession: vi.fn(() => Effect.succeed(undefined)),
  resolveProviderSession: vi.fn(() =>
    Effect.succeed(authorized ? ({} as McpCatalogGateway.McpCatalogGatewaySession) : undefined),
  ),
  handle: vi.fn(() => Effect.succeed(new Response("ok", { status: 200 }))),
  revokeRuntime: vi.fn(),
  disposeCatalogSession: vi.fn(),
  revokeAll: Effect.void,
});

const request = (authorization: string | undefined) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/mcp/catalog/catalog-1", {
      method: "POST",
      ...(authorization === undefined ? {} : { headers: { authorization } }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
  );

it.effect("authenticates provider-scoped catalog requests and forwards the session id", () =>
  Effect.gen(function* () {
    const registry = sessions(() => Effect.succeed({ providerSessionId: "provider-1" } as never));
    const service = gateway(true);
    const response = yield* handleMcpCatalogGatewayRequest(request("Bearer secret")).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
      Effect.provideService(McpCatalogGateway.McpCatalogGateway, service),
    );

    expect(response.status).toBe(200);
    expect(service.resolveProviderSession).toHaveBeenCalledWith(
      "provider-1",
      McpCatalogSessionId.make("catalog-1"),
    );
    expect(service.handle).toHaveBeenCalledWith(
      "provider-1",
      McpCatalogSessionId.make("catalog-1"),
      expect.any(Request),
    );
  }),
);

it.effect("rejects missing or unbound catalog credentials", () =>
  Effect.gen(function* () {
    const registry = sessions(() => Effect.succeed(undefined));
    const service = gateway(false);
    const response = yield* handleMcpCatalogGatewayRequest(request(undefined)).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
      Effect.provideService(McpCatalogGateway.McpCatalogGateway, service),
    );

    expect(response.status).toBe(401);
    expect(service.handle).not.toHaveBeenCalled();
  }),
);
