import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ExternalNotificationHomeAssistantDestination,
  ExternalNotificationError,
  type ExecutionEnvironmentDescriptor,
  ThreadId,
} from "@t3tools/contracts";
import type { ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
  settingsService?: ServerSettings.ServerSettingsService["Service"],
) {
  return ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, { send })),
    Layer.provide(
      settingsService === undefined
        ? ServerSettings.layerTest({
            externalNotifications: { destinations },
          })
        : Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
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

  it.effect("bounds concurrent delivery across destinations", () => {
    const destinations = Array.from({ length: 6 }, (_, index) =>
      decodeDestination({
        _tag: "home-assistant-webhook",
        id: `destination-${index}`,
        label: `Destination ${index}`,
        enabled: true,
        configured: true,
        webhookUrl: `http://destination-${index}.example.test/webhook`,
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Queue.unbounded<string>();
        const release = yield* Deferred.make<void>();
        const active = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const layer = makeDispatcherLayer(destinations, ({ destinationId }) =>
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (count) => count + 1);
            yield* Ref.update(peak, (count) => Math.max(count, current));
            yield* Queue.offer(started, destinationId);
            yield* Deferred.await(release);
            yield* Ref.update(active, (count) => count - 1);
          }),
        );

        yield* Effect.gen(function* () {
          const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
          const fiber = yield* dispatcher
            .dispatch({ environmentId, threadId, state, reason: "activity" })
            .pipe(Effect.forkScoped);
          yield* Effect.all(
            Array.from({ length: 4 }, () => Queue.take(started)),
            { concurrency: "unbounded" },
          );

          expect(yield* Ref.get(peak)).toBe(4);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          expect(yield* Ref.get(active)).toBe(0);
        }).pipe(Effect.provide(layer));
      }),
    );
  });

  it.effect("serializes concurrent duplicate dispatches before applying dedupe", () => {
    const destination = decodeDestination({
      _tag: "home-assistant-webhook",
      id: "selected",
      label: "Selected",
      enabled: true,
      configured: true,
      webhookUrl: "http://selected.example.test/webhook",
    });
    const sent: string[] = [];
    const layer = makeDispatcherLayer([destination], ({ destinationId }) =>
      Effect.sync(() => {
        sent.push(destinationId);
      }),
    );

    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      const input = { environmentId, threadId, state, reason: "activity" };
      yield* Effect.all([dispatcher.dispatch(input), dispatcher.dispatch(input)], {
        concurrency: 2,
      });

      expect(sent).toEqual(["selected"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("delivers current state to a new destination without resending existing ones", () =>
    Effect.gen(function* () {
      const first = decodeDestination({
        _tag: "home-assistant-webhook",
        id: "first",
        label: "First",
        enabled: true,
        configured: true,
        webhookUrl: "http://first.example.test/webhook",
      });
      const second = decodeDestination({
        _tag: "home-assistant-webhook",
        id: "second",
        label: "Second",
        enabled: true,
        configured: true,
        webhookUrl: "http://second.example.test/webhook",
      });
      const firstSettings: ServerSettingsValue = {
        ...DEFAULT_SERVER_SETTINGS,
        externalNotifications: {
          appScheme: "t3code-dev",
          destinations: [first],
        },
      };
      const settingsRef = yield* Ref.make(firstSettings);
      const settingsService = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: () => Effect.die("settings updates are not used here"),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });
      const sent: string[] = [];
      const layer = makeDispatcherLayer(
        [first],
        ({ destinationId }) =>
          Effect.sync(() => {
            sent.push(destinationId);
          }),
        settingsService,
      );

      yield* Effect.gen(function* () {
        const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
        const input = { environmentId, threadId, state, reason: "snapshot" };
        yield* dispatcher.dispatch(input);
        yield* Ref.set(settingsRef, {
          ...firstSettings,
          externalNotifications: {
            ...firstSettings.externalNotifications,
            destinations: [first, second],
          },
        });
        yield* dispatcher.dispatch(input);

        expect(sent).toEqual(["first", "second"]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
