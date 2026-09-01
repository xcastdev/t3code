import {
  EnvironmentId,
  ExternalNotificationHomeAssistantDestination,
  ExternalNotificationError,
  type ExecutionEnvironmentDescriptor,
  ThreadId,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ExternalNotificationDispatcher from "./ExternalNotificationDispatcher.ts";
import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

const decodeDestination = Schema.decodeUnknownSync(ExternalNotificationHomeAssistantDestination);
const decodeState = Schema.decodeUnknownSync(RelayAgentActivityState);

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const state = decodeState({
  environmentId,
  threadId,
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  phase: "running",
  headline: "Running",
  detail: "Working",
  updatedAt: "2026-08-31T00:00:00.000Z",
  deepLink: "/threads/environment-1/thread-1",
});

const descriptor = {
  environmentId,
  label: "Test environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
} satisfies ExecutionEnvironmentDescriptor;

function makeDispatcherLayer(
  destinations: ReadonlyArray<ReturnType<typeof decodeDestination>>,
  send: HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapterShape["send"],
) {
  return ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, { send })),
    Layer.provide(
      ServerSettings.layerTest({
        externalNotifications: { destinations },
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
  );
}

describe("ExternalNotificationDispatcher", () => {
  it("builds the payload with independently encoded links and metadata", () => {
    const payload = ExternalNotificationDispatcher.buildExternalNotificationPayload({
      appScheme: "t3code-preview",
      environmentId,
      threadId,
      state,
      test: false,
    });

    expect(payload).toMatchObject({
      schemaVersion: 1,
      test: false,
      environmentId,
      threadId,
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "Model",
      phase: "running",
      headline: "Running",
      detail: "Working",
      relativeRoute: "/threads/environment-1/thread-1",
      deepLink: "t3code-preview://threads/environment-1/thread-1",
    });
  });

  it("omits state metadata for a tombstone payload", () => {
    const payload = ExternalNotificationDispatcher.buildExternalNotificationPayload({
      appScheme: "t3code-dev",
      environmentId,
      threadId,
      state: null,
      test: false,
    });

    expect(payload).toEqual({
      schemaVersion: 1,
      test: false,
      environmentId,
      threadId,
      state: null,
      relativeRoute: "/threads/environment-1/thread-1",
      deepLink: "t3code-dev://threads/environment-1/thread-1",
    });
  });

  it.effect("isolates failures and advances identity only after successful delivery", () => {
    const sent: string[] = [];
    const destinations = [
      decodeDestination({
        _tag: "home-assistant-webhook",
        id: "failed",
        label: "Failed",
        enabled: true,
        configured: true,
        webhookUrl: "http://failed.example.test/webhook",
      }),
      decodeDestination({
        _tag: "home-assistant-webhook",
        id: "successful",
        label: "Successful",
        enabled: true,
        configured: true,
        webhookUrl: "http://successful.example.test/webhook",
      }),
      decodeDestination({
        _tag: "home-assistant-webhook",
        id: "disabled",
        label: "Disabled",
        enabled: false,
        configured: true,
        webhookUrl: "http://disabled.example.test/webhook",
      }),
      decodeDestination({
        _tag: "home-assistant-webhook",
        id: "unconfigured",
        label: "Unconfigured",
        enabled: true,
        configured: false,
        webhookUrl: "http://unconfigured.example.test/webhook",
      }),
    ];
    const layer = makeDispatcherLayer(destinations, ({ destinationId }) => {
      sent.push(destinationId);
      return destinationId === "failed"
        ? Effect.fail(new ExternalNotificationError({ destinationId, reason: "transport" }))
        : Effect.void;
    });

    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      const input = { environmentId, threadId, state, reason: "test" };
      yield* dispatcher.dispatch(input);
      yield* dispatcher.dispatch({
        ...input,
        state: { ...state, updatedAt: "2026-08-31T00:00:01.000Z" },
      });
      expect(sent).toEqual(["failed", "successful", "failed"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends tests to the selected configured destination without changing identity", () => {
    const sent: Array<{ readonly destinationId: string; readonly test: boolean }> = [];
    const destination = decodeDestination({
      _tag: "home-assistant-webhook",
      id: "selected",
      label: "Selected",
      enabled: true,
      configured: true,
      webhookUrl: "http://selected.example.test/webhook",
    });
    const disabledDestination = decodeDestination({
      _tag: "home-assistant-webhook",
      id: "disabled-selected",
      label: "Disabled selected",
      enabled: false,
      configured: true,
      webhookUrl: "http://disabled-selected.example.test/webhook",
    });
    const layer = makeDispatcherLayer([destination, disabledDestination], (input) =>
      Effect.sync(() => {
        sent.push({ destinationId: input.destinationId, test: input.payload.test });
      }),
    );

    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      yield* dispatcher.test("disabled-selected");
      yield* dispatcher.dispatch({ environmentId, threadId, state, reason: "activity" });

      expect(sent).toEqual([
        { destinationId: "disabled-selected", test: true },
        { destinationId: "selected", test: false },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
