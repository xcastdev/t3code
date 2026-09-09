import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid provider-scoped MCP bearer credential is required.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      },
    },
  );

const notFound = () => HttpServerResponse.empty({ status: 404 });

const endpointHandleFromRequest = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined => {
  const segments = new URL(request.originalUrl, "http://127.0.0.1").pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "mcp" || segments[2] !== "project") return undefined;
  const handle = segments[3];
  return handle && !handle.includes("%2f") && !handle.includes("%2F") ? handle : undefined;
};

const bearerFromRequest = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const value = request.headers.authorization;
  if (!value || !/^Bearer\s+\S+$/i.test(value)) return undefined;
  return value.replace(/^Bearer\s+/i, "").trim();
};

const toWebRequest = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Request, never> => HttpServerRequest.toWeb(request).pipe(Effect.orDie);

export const handleProjectMcpProxyRequest = Effect.fn("ProjectMcpProxyHttpServer.handle")(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const token = bearerFromRequest(request);
    const endpointHandle = endpointHandleFromRequest(request);
    if (!token || !endpointHandle) return unauthorized();

    const sessions = yield* McpSessionRegistry.McpSessionRegistry;
    const invocation = yield* sessions.resolve(token);
    if (!invocation || !invocation.capabilities.has("project")) return unauthorized();

    const proxy = yield* ProjectMcpProxyRegistry.ProjectMcpProxyRegistry;
    const endpoint = yield* proxy.resolve(invocation.providerSessionId, endpointHandle);
    if (!endpoint) return notFound();

    const webRequest = yield* toWebRequest(request);

    const response = yield* proxy
      .handle(invocation.providerSessionId, endpointHandle, webRequest)
      .pipe(
        Effect.catch((error) =>
          Effect.succeed(
            new Response(null, {
              status:
                error.code === "unauthorized" || error.code === "session_revoked"
                  ? 401
                  : error.code === "unknown_endpoint"
                    ? 404
                    : 502,
              headers:
                error.code === "unauthorized" || error.code === "session_revoked"
                  ? { "cache-control": "no-store", "www-authenticate": "Bearer" }
                  : { "cache-control": "no-store" },
            }),
          ),
        ),
      );
    return HttpServerResponse.fromWeb(response);
  },
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* McpSessionRegistry.McpSessionRegistry;
    const proxy = yield* ProjectMcpProxyRegistry.ProjectMcpProxyRegistry;
    const routeHandler = (request: HttpServerRequest.HttpServerRequest) =>
      handleProjectMcpProxyRequest(request).pipe(
        Effect.provideService(McpSessionRegistry.McpSessionRegistry, sessions),
        Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, proxy),
      );
    return HttpRouter.add("*", "/mcp/project/:endpointHandle", routeHandler);
  }),
);
