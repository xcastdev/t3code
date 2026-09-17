import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { McpCatalogSessionId } from "@t3tools/contracts";

import * as McpCatalogGateway from "./McpCatalogGateway.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid provider-scoped MCP bearer credential is required.",
    },
    {
      status: 401,
      headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
    },
  );

const catalogSessionIdFromRequest = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined => {
  const segments = new URL(request.originalUrl, "http://127.0.0.1").pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "mcp" || segments[2] !== "catalog") return undefined;
  const value = segments[3];
  if (!value || value.includes("%2f") || value.includes("%2F")) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const bearerFromRequest = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const value = request.headers.authorization;
  if (!value || !/^Bearer\s+\S+$/i.test(value)) return undefined;
  return value.replace(/^Bearer\s+/i, "").trim();
};

export const handleMcpCatalogGatewayRequest = Effect.fn("McpCatalogGatewayHttpServer.handle")(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const token = bearerFromRequest(request);
    const catalogSessionId = catalogSessionIdFromRequest(request);
    if (!token || !catalogSessionId) return unauthorized();

    const sessions = yield* McpSessionRegistry.McpSessionRegistry;
    const invocation = yield* sessions.resolve(token);
    if (!invocation) return unauthorized();

    const gateway = yield* McpCatalogGateway.McpCatalogGateway;
    const sessionId = McpCatalogSessionId.make(catalogSessionId);
    const session = yield* gateway.resolveProviderSession(invocation.providerSessionId, sessionId);
    if (!session) return unauthorized();

    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const response = yield* gateway.handle(invocation.providerSessionId, sessionId, webRequest);
    return HttpServerResponse.fromWeb(response);
  },
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* McpSessionRegistry.McpSessionRegistry;
    const gateway = yield* McpCatalogGateway.McpCatalogGateway;
    const routeHandler = (request: HttpServerRequest.HttpServerRequest) =>
      handleMcpCatalogGatewayRequest(request).pipe(
        Effect.provideService(McpSessionRegistry.McpSessionRegistry, sessions),
        Effect.provideService(McpCatalogGateway.McpCatalogGateway, gateway),
      );
    return HttpRouter.add("*", "/mcp/catalog/:catalogSessionId", routeHandler);
  }),
);
