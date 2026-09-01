import {
  EnvironmentId,
  ExternalNotificationError,
  ExternalNotificationPayload,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const payload: ExternalNotificationPayload = {
  schemaVersion: 1,
  test: true,
  environmentId,
  threadId,
  state: null,
  relativeRoute: "/threads/environment-1/thread-1",
  deepLink: "t3code-dev://threads/environment-1/thread-1",
};

function makeAdapterLayer(input: {
  readonly response?: () => Response;
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make(
    input.execute ??
      ((request) =>
        Effect.sync(() => {
          requests.push(request);
          return HttpClientResponse.fromWeb(request, input.response?.() ?? new Response(null));
        })),
  );
  return {
    requests,
    layer: HomeAssistantWebhookAdapter.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
  };
}

const sendInput = {
  destinationId: "destination-1",
  webhookUrl: "https://home.example.test/api/webhook/id",
  payload,
};

describe("HomeAssistantWebhookAdapter", () => {
  it.effect("posts a configured webhook with a JSON request", () => {
    const adapter = makeAdapterLayer({ response: () => new Response(null, { status: 204 }) });

    return Effect.gen(function* () {
      const service = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
      yield* service.send(sendInput);

      const request = adapter.requests[0];
      assert.isDefined(request);
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, sendInput.webhookUrl);
      assert.strictEqual(request.headers["content-type"], "application/json");
    }).pipe(Effect.provide(adapter.layer));
  });

  it.effect("maps an HTTP failure to a typed error", () => {
    const adapter = makeAdapterLayer({ response: () => new Response(null, { status: 503 }) });

    return Effect.gen(function* () {
      const service = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
      const error = yield* Effect.flip(service.send(sendInput));

      assert.instanceOf(error, ExternalNotificationError);
      assert.deepInclude(error, {
        destinationId: "destination-1",
        reason: "http-status",
        status: 503,
      });
    }).pipe(Effect.provide(adapter.layer));
  });

  it.effect("rejects malformed URLs before making a request", () => {
    const adapter = makeAdapterLayer({ response: () => new Response(null, { status: 204 }) });

    return Effect.gen(function* () {
      const service = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
      const error = yield* Effect.flip(service.send({ ...sendInput, webhookUrl: "not a URL" }));

      assert.deepInclude(error, {
        destinationId: "destination-1",
        reason: "malformed-url",
      });
      assert.isEmpty(adapter.requests);
    }).pipe(Effect.provide(adapter.layer));
  });
});
