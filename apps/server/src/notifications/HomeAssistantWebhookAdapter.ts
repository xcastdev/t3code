import { ExternalNotificationError, type ExternalNotificationPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const HOME_ASSISTANT_TIMEOUT = "10 seconds";
const isExternalNotificationError = Schema.is(ExternalNotificationError);

export interface HomeAssistantWebhookAdapterShape {
  readonly send: (input: {
    readonly destinationId: string;
    readonly webhookUrl: string;
    readonly payload: ExternalNotificationPayload;
  }) => Effect.Effect<void, ExternalNotificationError>;
}

export class HomeAssistantWebhookAdapter extends Context.Service<
  HomeAssistantWebhookAdapter,
  HomeAssistantWebhookAdapterShape
>()("t3/notifications/HomeAssistantWebhookAdapter") {}

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const send: HomeAssistantWebhookAdapterShape["send"] = Effect.fn(
    "HomeAssistantWebhookAdapter.send",
  )(function* (input) {
    const url = yield* Effect.try({
      try: () => {
        const parsed = new URL(input.webhookUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("unsupported protocol");
        }
        return parsed.toString();
      },
      catch: () =>
        new ExternalNotificationError({
          destinationId: input.destinationId,
          reason: "malformed-url",
        }),
    });

    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(input.payload),
      Effect.map(HttpClientRequest.setHeader("content-type", "application/json")),
      Effect.mapError(
        () =>
          new ExternalNotificationError({
            destinationId: input.destinationId,
            reason: "transport",
          }),
      ),
    );

    const response = yield* client.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: HOME_ASSISTANT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ExternalNotificationError({
              destinationId: input.destinationId,
              reason: "timeout",
            }),
          ),
      }),
      Effect.catch((cause) =>
        isExternalNotificationError(cause)
          ? Effect.fail(cause)
          : Effect.fail(
              new ExternalNotificationError({
                destinationId: input.destinationId,
                reason: "transport",
              }),
            ),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      return yield* new ExternalNotificationError({
        destinationId: input.destinationId,
        reason: "http-status",
        status: response.status,
      });
    }
  });

  return HomeAssistantWebhookAdapter.of({ send });
});

export const layer = Layer.effect(HomeAssistantWebhookAdapter, make);
