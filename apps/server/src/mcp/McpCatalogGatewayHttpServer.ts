import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Registry from "./McpSessionRegistry.ts";
import * as Gateway from "./McpCatalogGateway.ts";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const registry = yield* Registry.McpSessionRegistry;
  const scope = bearer ? yield* registry.resolve(bearer) : undefined;
  if (!scope)
    return HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": "Bearer" } });
  const webRequest = yield* HttpServerRequest.toWeb(request);
  const pathIdentity = new URL(webRequest.url).pathname.slice("/mcp/catalog/".length);
  const gateway = yield* Gateway.McpCatalogGateway;
  return HttpServerResponse.fromWeb(
    yield* gateway.handle(scope.thread.providerSessionId, pathIdentity, webRequest),
  );
});
export const layer = HttpRouter.add("*", "/mcp/catalog/:identity", handler);
