import {
  buildExternalNotificationDeepLink,
  buildExternalNotificationRelativeRoute,
  ExternalNotificationError,
  type ExternalNotificationDestination,
  type ExternalNotificationPayload,
  ExternalNotificationTestResult,
  type EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

const MAX_DESTINATION_CONCURRENCY = 4;

export interface ExternalNotificationDispatchInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly reason: string;
}

export interface ExternalNotificationDispatcherShape {
  readonly dispatch: (input: ExternalNotificationDispatchInput) => Effect.Effect<void>;
  readonly hasEnabledDestinations: Effect.Effect<boolean>;
  readonly test: (
    destinationId: string,
  ) => Effect.Effect<ExternalNotificationTestResult, ExternalNotificationError>;
}

export class ExternalNotificationDispatcher extends Context.Service<
  ExternalNotificationDispatcher,
  ExternalNotificationDispatcherShape
>()("t3/notifications/ExternalNotificationDispatcher") {}

export function externalNotificationPublishIdentity(state: RelayAgentActivityState | null): string {
  if (state === null) return "null";
  const { updatedAt: _updatedAt, ...meaningfulState } = state;
  return JSON.stringify(meaningfulState);
}

export function buildExternalNotificationPayload(input: {
  readonly appScheme: Parameters<typeof buildExternalNotificationDeepLink>[0]["appScheme"];
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly test: boolean;
}): ExternalNotificationPayload {
  return {
    schemaVersion: 1,
    test: input.test,
    environmentId: input.environmentId,
    threadId: input.threadId,
    state: input.state,
    ...(input.state === null
      ? {}
      : {
          projectTitle: input.state.projectTitle,
          threadTitle: input.state.threadTitle,
          modelTitle: input.state.modelTitle,
          phase: input.state.phase,
          headline: input.state.headline,
          ...(input.state.detail === undefined ? {} : { detail: input.state.detail }),
        }),
    relativeRoute: buildExternalNotificationRelativeRoute(input),
    deepLink: buildExternalNotificationDeepLink({
      appScheme: input.appScheme,
      environmentId: input.environmentId,
      threadId: input.threadId,
    }),
  };
}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const homeAssistant = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
  const identities = yield* Ref.make(new Map<string, string>());
  const dispatchSemaphore = yield* Semaphore.make(1);
  const isConfigured = (
    destination: ExternalNotificationDestination,
  ): destination is ExternalNotificationDestination & { readonly webhookUrl: string } =>
    destination.enabled && destination.configured && Boolean(destination.webhookUrl?.trim());
  const isTestConfigured = (
    destination: ExternalNotificationDestination,
  ): destination is ExternalNotificationDestination & { readonly webhookUrl: string } =>
    destination.configured && Boolean(destination.webhookUrl?.trim());
  const compileAdapter = (
    destination: ExternalNotificationDestination & { readonly webhookUrl: string },
  ) => {
    switch (destination._tag) {
      case "home-assistant-webhook":
        return (payload: ExternalNotificationPayload) =>
          homeAssistant.send({
            destinationId: destination.id,
            webhookUrl: destination.webhookUrl,
            payload,
          });
    }
  };
  const getConfiguredDestinations = Effect.fn("ExternalNotificationDispatcher.getDestinations")(
    function* () {
      const settings = yield* serverSettings.getSettings;
      return {
        appScheme: settings.externalNotifications.appScheme,
        destinations: settings.externalNotifications.destinations.filter(isConfigured),
      };
    },
  );
  const hasEnabledDestinations = getConfiguredDestinations().pipe(
    Effect.map(({ destinations }) => destinations.length > 0),
    Effect.orElseSucceed(() => false),
  );
  const logFailure = (error: unknown, destinationId: string) =>
    Effect.logWarning("external notification delivery failed", {
      destinationId,
      reason: Schema.is(ExternalNotificationError)(error) ? error.reason : "transport",
    });
  const dispatchUnsafe = Effect.fn("ExternalNotificationDispatcher.dispatch")(function* (
    input: ExternalNotificationDispatchInput,
  ) {
    const { appScheme, destinations } = yield* getConfiguredDestinations();
    const activeIds = new Set(destinations.map(({ id }) => id));
    yield* Ref.update(identities, (current) => {
      const next = new Map(current);
      for (const key of next.keys())
        if (!activeIds.has(key.slice(0, key.indexOf("\u0000")))) next.delete(key);
      return next;
    });
    const identity = externalNotificationPublishIdentity(input.state);
    const payload = buildExternalNotificationPayload({ ...input, appScheme, test: false });
    yield* Effect.forEach(
      destinations,
      (destination) => {
        const key = `${destination.id}\u0000${input.threadId}`;
        return Effect.gen(function* () {
          if ((yield* Ref.get(identities)).get(key) === identity) return;
          yield* compileAdapter(destination)(payload).pipe(
            Effect.tap(() =>
              Ref.update(identities, (current) => new Map(current).set(key, identity)),
            ),
            Effect.catch((error) => logFailure(error, destination.id)),
          );
        });
      },
      { concurrency: MAX_DESTINATION_CONCURRENCY, discard: true },
    );
  });
  const dispatch: ExternalNotificationDispatcherShape["dispatch"] = (input) =>
    dispatchSemaphore
      .withPermits(1)(dispatchUnsafe(input))
      .pipe(Effect.orElseSucceed(() => undefined));
  const test: ExternalNotificationDispatcherShape["test"] = Effect.fn(
    "ExternalNotificationDispatcher.test",
  )(function* (destinationId) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () => new ExternalNotificationError({ destinationId, reason: "not-configured" }),
      ),
    );
    const destination = settings.externalNotifications.destinations.find(
      (item) => item.id === destinationId,
    );
    if (destination === undefined || !isTestConfigured(destination)) {
      return yield* new ExternalNotificationError({ destinationId, reason: "not-configured" });
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const payload = buildExternalNotificationPayload({
      appScheme: settings.externalNotifications.appScheme,
      environmentId,
      threadId: ThreadId.make("external-notification-test"),
      state: null,
      test: true,
    });
    yield* compileAdapter(destination)(payload);
    return { destinationId, delivered: true };
  });
  return ExternalNotificationDispatcher.of({ dispatch, hasEnabledDestinations, test });
});

export const layer = Layer.effect(ExternalNotificationDispatcher, make);
export const layerTest = Layer.succeed(ExternalNotificationDispatcher, {
  dispatch: () => Effect.void,
  hasEnabledDestinations: Effect.succeed(false),
  test: (destinationId) =>
    Effect.fail(new ExternalNotificationError({ destinationId, reason: "not-configured" })),
} satisfies ExternalNotificationDispatcherShape);
