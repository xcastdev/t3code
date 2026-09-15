import {
  EnvironmentId,
  ExternalNotificationError,
  type ExternalNotificationPayload,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

const payload: ExternalNotificationPayload = {
  schemaVersion: 1,
  test: true,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  state: null,
  relativeRoute: "/threads/environment/thread",
  deepLink: "t3code-dev://threads/environment/thread",
};

it.effect("HomeAssistantWebhookAdapter posts JSON and maps non-success responses", () => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
    }),
  );
  const layer = HomeAssistantWebhookAdapter.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return Effect.gen(function* () {
    const service = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
    const error = yield* Effect.flip(
      service.send({
        destinationId: "home",
        webhookUrl: "https://home.example.test/api/webhook/token",
        payload,
      }),
    );
    assert.instanceOf(error, ExternalNotificationError);
    assert.deepInclude(error, { destinationId: "home", reason: "http-status", status: 503 });
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.headers["content-type"], "application/json");
  }).pipe(Effect.provide(layer));
});
