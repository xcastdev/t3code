import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export interface ExternalNotificationPayload {
  readonly schemaVersion: 1;
  readonly test: boolean;
  readonly kind: "notification" | "work-attention" | "test";
  readonly title: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
}

export class ExternalNotificationError extends Schema.TaggedError<ExternalNotificationError>()(
  "ExternalNotificationError",
  {
    reason: Schema.Literals([
      "unconfigured",
      "malformed-url",
      "transport",
      "timeout",
      "http-status",
    ]),
  },
) {
  override get message() {
    return `External notification delivery failed (${this.reason}).`;
  }
}

export class HomeAssistantWebhookAdapter extends Context.Service<
  HomeAssistantWebhookAdapter,
  {
    readonly send: (
      webhookUrl: string,
      payload: ExternalNotificationPayload,
    ) => Effect.Effect<void, ExternalNotificationError>;
  }
>()("t3/notifications/HomeAssistantWebhookAdapter") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const send = Effect.fn("HomeAssistantWebhookAdapter.send")(function* (
    webhookUrl: string,
    payload: ExternalNotificationPayload,
  ) {
    const url = yield* Effect.try({
      try: () => {
        const parsed = new URL(webhookUrl);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.hash
        )
          throw new Error();
        return parsed.toString();
      },
      catch: () => new ExternalNotificationError({ reason: "malformed-url" }),
    });
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.mapError(() => new ExternalNotificationError({ reason: "transport" })),
    );
    // The webhook path is a credential; suppress HTTP URL spans and propagation.
    const response = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(
        Effect.provideService(Tracer.DisablePropagation, true),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.scoped,
        Effect.mapError(() => new ExternalNotificationError({ reason: "transport" })),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new ExternalNotificationError({ reason: "timeout" })),
        }),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new ExternalNotificationError({ reason: "http-status" });
  });
  return HomeAssistantWebhookAdapter.of({ send });
});
export const layer = Layer.effect(HomeAssistantWebhookAdapter, make);
