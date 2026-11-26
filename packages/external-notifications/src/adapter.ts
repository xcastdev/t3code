import {
  ExternalNotificationFailureReason,
  type ExternalNotificationEvent,
  type ExternalNotificationTestEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type WebhookEvent = ExternalNotificationEvent | ExternalNotificationTestEvent;

export class ExternalNotificationError extends Schema.TaggedError<
  ExternalNotificationError,
  { readonly brand: unique symbol }
>()("ExternalNotificationError", {
  reason: ExternalNotificationFailureReason,
  knownFailure: Schema.optionalKey(Schema.Boolean),
}) {
  override get message() {
    return `External notification delivery failed (${this.reason}).`;
  }
}

export interface WebhookAdapter {
  readonly encode: (
    event: WebhookEvent,
    signingKey: string | undefined,
  ) => Effect.Effect<
    { readonly body: Uint8Array<ArrayBuffer>; readonly signature?: string },
    ExternalNotificationError
  >;
}

const encodeWebhookBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const encodeWebhookBytes = (payload: unknown) =>
  encodeWebhookBody(payload).pipe(
    Effect.map((json) => new TextEncoder().encode(json)),
    Effect.mapError(() => new ExternalNotificationError({ reason: "unconfigured" })),
  );
