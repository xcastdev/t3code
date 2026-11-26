import * as Effect from "effect/Effect";
import { encodeWebhookBytes, type WebhookAdapter, type WebhookEvent } from "./adapter.ts";

export function homeAssistantPayload(event: WebhookEvent) {
  const test = event.eventType === "test";
  return {
    schemaVersion: 1,
    test,
    kind: test ? "test" : event.eventType === "work-attention" ? "work-attention" : "notification",
    title: event.title.slice(0, 1024),
    environmentId: event.environmentId,
    environmentName: event.environmentName.trim() ? event.environmentName : event.environmentId,
    threadId: event.threadId,
    projectId: event.projectId,
    taskId: event.taskId,
  } as const;
}

export const homeAssistantWebhookAdapter: WebhookAdapter = {
  encode: Effect.fn("HomeAssistantWebhookAdapter.encode")((event) =>
    encodeWebhookBytes(homeAssistantPayload(event)).pipe(Effect.map((body) => ({ body }))),
  ),
};
