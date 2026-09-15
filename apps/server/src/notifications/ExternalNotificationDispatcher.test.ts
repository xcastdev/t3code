import {
  EnvironmentId,
  ExternalNotificationError,
  ExternalNotificationHomeAssistantDestination,
  ThreadId,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ExternalNotificationDispatcher from "./ExternalNotificationDispatcher.ts";
import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const destination = Schema.decodeUnknownSync(ExternalNotificationHomeAssistantDestination)({
  _tag: "home-assistant-webhook",
  id: "home",
  label: "Home Assistant",
  enabled: true,
  configured: true,
  webhookUrl: "https://home.example.test/api/webhook/token",
});
const state = Schema.decodeUnknownSync(RelayAgentActivityState)({
  environmentId,
  threadId,
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-09-01T00:00:00.000Z",
  deepLink: "/threads/environment/thread",
});

it.effect(
  "ExternalNotificationDispatcher deduplicates state excluding updatedAt and sends tombstones",
  () => {
    const sent: unknown[] = [];
    const layer = ExternalNotificationDispatcher.layer.pipe(
      Layer.provide(
        Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
          send: ({ payload }) => Effect.sync(() => sent.push(payload)),
        }),
      ),
      Layer.provide(
        ServerSettings.layerTest({ externalNotifications: { destinations: [destination] } }),
      ),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      yield* dispatcher.dispatch({ environmentId, threadId, state, reason: "activity" });
      yield* dispatcher.dispatch({
        environmentId,
        threadId,
        state: { ...state, updatedAt: "2026-09-01T00:00:01.000Z" },
        reason: "activity",
      });
      yield* dispatcher.dispatch({ environmentId, threadId, state: null, reason: "deleted" });
      assert.equal(sent.length, 2);
      assert.deepInclude(sent[1], { state: null, schemaVersion: 1 });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("ExternalNotificationDispatcher rejects tests for an unconfigured destination", () => {
  const layer = ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
        send: () => Effect.void,
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );
  return Effect.gen(function* () {
    const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
    const error = yield* Effect.flip(dispatcher.test("missing"));
    assert.instanceOf(error, ExternalNotificationError);
    assert.equal(error.reason, "not-configured");
  }).pipe(Effect.provide(layer));
});
