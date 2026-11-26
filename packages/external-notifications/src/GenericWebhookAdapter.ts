import * as Effect from "effect/Effect";
import { encodeWebhookBytes, ExternalNotificationError, type WebhookAdapter } from "./adapter.ts";
import { homeAssistantPayload } from "./HomeAssistantWebhookAdapter.ts";

export const genericWebhookAdapter: WebhookAdapter = {
  encode: Effect.fn("GenericWebhookAdapter.encode")(function* (event, signingKey) {
    const body = yield* encodeWebhookBytes({
      ...homeAssistantPayload(event),
      occurrenceId: event.occurrenceId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      ...(event.eventType === "work-attention" ? { reason: event.reason } : {}),
    });
    if (!signingKey) return { body };
    const signature = yield* Effect.tryPromise({
      try: async () => {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(signingKey),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const mac = await crypto.subtle.sign("HMAC", key, body);
        const hex = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0"));
        return `sha256=${hex.join("")}`;
      },
      catch: () => new ExternalNotificationError({ reason: "unconfigured" }),
    });
    return { body, signature };
  }),
};
