import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ProjectMcpOAuth from "./ProjectMcpOAuth.ts";
import * as ProjectMcpOAuthHttp from "./ProjectMcpOAuthHttp.ts";

const requestFor = (url: string) =>
  HttpServerRequest.fromWeb(
    new Request(url, {
      method: "GET",
      headers: {
        host: new URL(url).host,
        ...(new URL(url).protocol === "https:" ? { "x-forwarded-proto": "https" } : {}),
      },
    }),
  );

it.effect("returns a generic non-cacheable response when callback validation fails", () =>
  ProjectMcpOAuthHttp.handleProjectMcpOAuthCallbackRequest()
    .pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        requestFor("http://127.0.0.1/oauth/project-mcp/callback"),
      ),
      Effect.provideService(ProjectMcpOAuth.ProjectMcpOAuth, {
        status: () => Effect.succeed("not-connected"),
        providerFor: () => Effect.die("unused"),
        begin: () => Effect.die("unused"),
        continuePending: () => Effect.die("unused"),
        completeCallback: () =>
          Effect.fail(
            new ProjectMcpOAuth.ProjectMcpOAuthError({
              operation: "test",
              cause: "sensitive provider failure",
            }),
          ),
        disconnect: () => Effect.die("unused"),
      }),
    )
    .pipe(
      Effect.map(HttpServerResponse.toWeb),
      Effect.tap((response) =>
        Effect.sync(() => {
          if (response.status !== 400) throw new Error(`expected 400, received ${response.status}`);
          if (response.headers.get("cache-control") !== "no-store") {
            throw new Error("OAuth callback response must not be cached");
          }
        }),
      ),
    ),
);

it.effect("passes a successful OAuth callback response through unchanged", () =>
  ProjectMcpOAuthHttp.handleProjectMcpOAuthCallbackRequest()
    .pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        requestFor("http://127.0.0.1/oauth/project-mcp/callback?state=s&code=c"),
      ),
      Effect.provideService(ProjectMcpOAuth.ProjectMcpOAuth, {
        status: () => Effect.succeed("not-connected"),
        providerFor: () => Effect.die("unused"),
        begin: () => Effect.die("unused"),
        continuePending: () => Effect.die("unused"),
        completeCallback: () => Effect.succeed(new Response("complete", { status: 200 })),
        disconnect: () => Effect.die("unused"),
      }),
    )
    .pipe(
      Effect.map(HttpServerResponse.toWeb),
      Effect.tap((response) =>
        Effect.sync(() => {
          if (response.status !== 200) throw new Error(`expected 200, received ${response.status}`);
        }),
      ),
    ),
);

it.effect("serves an HTTPS Client ID Metadata Document without secrets", () =>
  ProjectMcpOAuthHttp.handleProjectMcpOAuthClientMetadataRequest().pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      requestFor("https://t3.example.test/oauth/project-mcp/client-metadata"),
    ),
    Effect.map(HttpServerResponse.toWeb),
    Effect.tap((response) =>
      Effect.gen(function* () {
        if (response.status !== 200) throw new Error(`expected 200, received ${response.status}`);
        const metadata = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
        assert.equal(
          metadata.client_id,
          "https://t3.example.test/oauth/project-mcp/client-metadata",
        );
        assert.deepEqual(metadata.redirect_uris, [
          "https://t3.example.test/oauth/project-mcp/callback",
        ]);
      }),
    ),
  ),
);

it.effect("does not advertise a Client ID Metadata Document over non-TLS HTTP", () =>
  ProjectMcpOAuthHttp.handleProjectMcpOAuthClientMetadataRequest().pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      requestFor("http://t3.example.test/oauth/project-mcp/client-metadata"),
    ),
    Effect.map(HttpServerResponse.toWeb),
    Effect.tap((response) =>
      Effect.sync(() => {
        if (response.status !== 404) throw new Error(`expected 404, received ${response.status}`);
      }),
    ),
  ),
);
