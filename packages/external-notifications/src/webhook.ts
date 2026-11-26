import { SECRET_REDACTED, type ExternalNotificationDestination } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ExternalNotificationError, type WebhookAdapter, type WebhookEvent } from "./adapter.ts";
import { genericWebhookAdapter } from "./GenericWebhookAdapter.ts";
import { homeAssistantWebhookAdapter } from "./HomeAssistantWebhookAdapter.ts";

export { ExternalNotificationError } from "./adapter.ts";

const adapters: Record<ExternalNotificationDestination["kind"], WebhookAdapter> = {
  "home-assistant": homeAssistantWebhookAdapter,
  "generic-webhook": genericWebhookAdapter,
};

export const sendExternalNotification = Effect.fn("sendExternalNotification")(function* (
  destination: ExternalNotificationDestination,
  event: WebhookEvent,
  requestStarted?: () => boolean,
) {
  if (
    !destination.webhookUrl ||
    destination.webhookUrl === SECRET_REDACTED ||
    (destination.kind === "generic-webhook" && destination.signingKey === SECRET_REDACTED)
  ) {
    return yield* new ExternalNotificationError({ reason: "unconfigured" });
  }
  const url = URL.parse(destination.webhookUrl);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.includes("#")
  ) {
    return yield* new ExternalNotificationError({ reason: "malformed-url" });
  }

  const client = yield* HttpClient.HttpClient;
  const { body, signature } = yield* adapters[destination.kind].encode(
    event,
    destination.signingKey,
  );
  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyUint8Array(body, "application/json"),
    signature ? HttpClientRequest.setHeader("X-T3-Signature", signature) : (request) => request,
  );

  // The webhook URL and signature are credentials and must stay out of HTTP telemetry.
  const knownFailure = () => (requestStarted?.() === false ? { knownFailure: true } : {});
  const status = yield* HttpClient.withScope(client)
    .execute(request)
    .pipe(
      Effect.map((response) => response.status),
      Effect.provideService(Tracer.DisablePropagation, true),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.scoped,
      Effect.withTracerEnabled(false),
      Effect.mapError(
        () =>
          new ExternalNotificationError({
            reason: "transport",
            ...knownFailure(),
          }),
      ),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(new ExternalNotificationError({ reason: "timeout", ...knownFailure() })),
      }),
    );
  if (status < 200 || status >= 300) {
    return yield* new ExternalNotificationError({ reason: "http-status" });
  }
});
