import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ProjectMcpOAuth from "./ProjectMcpOAuth.ts";

export const projectMcpOAuthCallbackPath = "/oauth/project-mcp/callback";
export const projectMcpOAuthClientMetadataPath = "/oauth/project-mcp/client-metadata";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Adapts the Web-standard OAuth callback service to T3's Effect HTTP router.
 * The OAuth service owns validation and state consumption; this layer only
 * performs the request/response conversion and deliberately returns a generic
 * failure page so provider errors cannot be reflected to the browser.
 */
export const handleProjectMcpOAuthCallbackRequest = Effect.fn("ProjectMcpOAuthHttp.handleCallback")(
  function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const oauth = yield* ProjectMcpOAuth.ProjectMcpOAuth;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* oauth.completeCallback(webRequest).pipe(
      Effect.catch(() =>
        Effect.succeed(
          new Response("OAuth authorization could not be completed.", {
            status: 400,
            headers: { "cache-control": "no-store" },
          }),
        ),
      ),
    );
    return HttpServerResponse.fromWeb(response);
  },
);

export const handleProjectMcpOAuthClientMetadataRequest = Effect.fn(
  "ProjectMcpOAuthHttp.handleClientMetadata",
)(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || url.value.protocol !== "https:") {
    return HttpServerResponse.fromWeb(new Response("Not Found", { status: 404 }));
  }
  const clientId = new URL(projectMcpOAuthClientMetadataPath, url.value.origin).toString();
  const redirectUri = new URL(projectMcpOAuthCallbackPath, url.value.origin).toString();
  return HttpServerResponse.fromWeb(
    new Response(
      encodeJson({
        client_id: clientId,
        client_name: "T3 Code",
        redirect_uris: [redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
      {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "application/json",
        },
      },
    ),
  );
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const oauth = yield* ProjectMcpOAuth.ProjectMcpOAuth;
    const routeHandler = handleProjectMcpOAuthCallbackRequest().pipe(
      Effect.provideService(ProjectMcpOAuth.ProjectMcpOAuth, oauth),
    );
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        projectMcpOAuthClientMetadataPath,
        handleProjectMcpOAuthClientMetadataRequest(),
      ),
      HttpRouter.add("GET", projectMcpOAuthCallbackPath, routeHandler),
    );
  }),
);
