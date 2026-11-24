import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import { attachedTargetForRequestUrl, readDesktopPrimaryBearerToken } from "./desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

function withPrimaryBearerToken(client: HttpClient.HttpClient): HttpClient.HttpClient {
  // API clients append base-URL preprocessing; bind credentials only after it has run.
  return HttpClient.makeWith(
    (requestEffect) =>
      client.postprocess(
        requestEffect.pipe(
          Effect.flatMap((request) =>
            // A destination mismatch refuses the request itself rather than reading as a transport failure.
            Effect.sync(() => attachedTargetForRequestUrl(request.url) ?? "managed").pipe(
              Effect.flatMap((target) =>
                Effect.tryPromise({
                  try: () => readDesktopPrimaryBearerToken(target),
                  catch: (cause) =>
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.TransportError({ request, cause }),
                    }),
                }),
              ),
              Effect.map((bearerToken) =>
                bearerToken ? HttpClientRequest.bearerToken(request, bearerToken) : request,
              ),
            ),
          ),
        ),
      ),
    client.preprocess,
  );
}

export function layerForCurrentOrigin() {
  return Layer.unwrap(
    Effect.sync(() => {
      const layerBase = layerRemoteHttpClient(globalThis.fetch);
      if (isSameOriginBrowserPrimary()) {
        return Layer.merge(
          layerBase,
          Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
        );
      }

      const layerBearerClient = Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, withPrimaryBearerToken),
      ).pipe(Layer.provide(layerBase));

      return Layer.merge(
        layerBearerClient,
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
      );
    }),
  );
}

export const layer = layerForCurrentOrigin();
