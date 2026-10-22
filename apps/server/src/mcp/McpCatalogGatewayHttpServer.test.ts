import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { layer } from "./McpCatalogGatewayHttpServer.ts";
import { McpCatalogGateway } from "./McpCatalogGateway.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

it.effect("a catalog URL is not authority and builtin /mcp routing coexists", () =>
  Effect.gen(function* () {
    const scope: McpThreadInvocationScope = {
      environmentId: EnvironmentId.make("env"),
      requestNamespace: "issued",
      thread: {
        threadId: ThreadId.make("thread"),
        providerSessionId: "issued",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(),
      issuedAt: 0,
    };
    const routes = Layer.merge(
      layer,
      HttpRouter.add("GET", "/mcp", Effect.succeed(HttpServerResponse.text("builtin"))),
    ).pipe(
      Layer.provideMerge(
        Layer.mock(McpSessionRegistry)({
          resolve: (token) => Effect.succeed(token === "valid" ? scope : undefined),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(McpCatalogGateway)({
          handle: (identity, path) =>
            Effect.succeed(
              new Response(identity === path ? "catalog" : "denied", {
                status: identity === path ? 200 : 401,
              }),
            ),
        }),
      ),
    );
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (value) => Effect.promise(() => value.dispose()),
    );
    const request = (path: string, authorization?: string) =>
      Effect.promise(() =>
        web.handler(
          new Request(
            `http://localhost${path}`,
            authorization ? { headers: { authorization } } : {},
          ),
        ),
      );
    expect((yield* request("/mcp/catalog/issued")).status).toBe(401);
    expect((yield* request("/mcp/catalog/issued", "Bearer invalid")).status).toBe(401);
    expect((yield* request("/mcp/catalog/other", "Bearer valid")).status).toBe(401);
    expect((yield* request("/mcp/catalog/issued", "Bearer valid")).status).toBe(200);
    const builtin = yield* request("/mcp");
    expect(yield* Effect.promise(() => builtin.text())).toBe("builtin");
  }),
);
