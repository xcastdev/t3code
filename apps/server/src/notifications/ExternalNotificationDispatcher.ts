import {
  buildExternalNotificationDeepLink,
  buildExternalNotificationRelativeRoute,
  ExternalNotificationError,
  type ExternalNotificationDestination,
  type ExternalNotificationPayload,
  ProjectId,
  ProjectWorkTaskId,
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
import * as ProjectWorkContentGuard from "../projectWork/ProjectWorkContentGuard.ts";

const MAX_DESTINATION_CONCURRENCY = 4;

export interface ExternalNotificationDispatchInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly reason: string;
  readonly projectWork?: {
    readonly projectId: string;
    readonly taskId: string;
    readonly state: string;
    readonly reason: string;
    readonly revision: number;
  };
  /** Durable publications own deduplication; do not use the process cache. */
  readonly bypassMemoryDedup?: boolean;
  /** Backward-compatible name for callers that describe the old cache explicitly. */
  readonly bypassLegacyDedup?: boolean;
  /** Retry only these configured destination ids after a partial outcome. */
  readonly destinationIds?: ReadonlyArray<string>;
}

export interface ExternalNotificationDestinationOutcome {
  readonly destinationId: string;
  readonly status: "delivered" | "failed";
  readonly reason?: string;
}

export interface ExternalNotificationDispatchResult {
  readonly attemptedDestinationIds: ReadonlyArray<string>;
  readonly deliveredDestinationIds: ReadonlyArray<string>;
  readonly failedDestinationIds: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<ExternalNotificationDestinationOutcome>;
}

export interface ExternalNotificationDispatcherShape {
  readonly dispatch: (
    input: ExternalNotificationDispatchInput,
  ) => Effect.Effect<ExternalNotificationDispatchResult>;
  readonly dispatchDetailed: ExternalNotificationDispatcherShape["dispatch"];
  readonly hasEnabledDestinations: Effect.Effect<boolean>;
  readonly test: (
    destinationId: string,
  ) => Effect.Effect<ExternalNotificationTestResult, ExternalNotificationError>;
}

export class ExternalNotificationDispatcher extends Context.Service<
  ExternalNotificationDispatcher,
  ExternalNotificationDispatcherShape
>()("t3/notifications/ExternalNotificationDispatcher") {}

export function externalNotificationPublishIdentity(
  state: RelayAgentActivityState | null,
  projectWork?: ExternalNotificationDispatchInput["projectWork"],
): string {
  const meaningfulState =
    state === null ? null : (({ updatedAt: _updatedAt, ...rest }) => rest)(state);
  return JSON.stringify({
    state: meaningfulState,
    ...(projectWork === undefined ? {} : { projectWork }),
  });
}

const emptyDispatchResult = (): ExternalNotificationDispatchResult => ({
  attemptedDestinationIds: [],
  deliveredDestinationIds: [],
  failedDestinationIds: [],
  outcomes: [],
});

export function buildExternalNotificationPayload(input: {
  readonly appScheme: Parameters<typeof buildExternalNotificationDeepLink>[0]["appScheme"];
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly test: boolean;
  readonly projectWork?: ExternalNotificationDispatchInput["projectWork"];
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
    ...(input.projectWork === undefined
      ? {}
      : {
          projectWork: {
            projectId: ProjectId.make(input.projectWork.projectId),
            taskId: ProjectWorkTaskId.make(input.projectWork.taskId),
            state: input.projectWork.state,
            reason: input.projectWork.reason,
            revision: input.projectWork.revision,
          },
        }),
  };
}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const homeAssistant = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
  const contentGuard = yield* Effect.serviceOption(ProjectWorkContentGuard.ProjectWorkContentGuard);
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
    const selectedDestinations =
      input.destinationIds === undefined
        ? destinations
        : destinations.filter((destination) => input.destinationIds?.includes(destination.id));
    const activeIds = new Set(selectedDestinations.map(({ id }) => id));
    yield* Ref.update(identities, (current) => {
      const next = new Map(current);
      for (const key of next.keys())
        if (!destinations.some(({ id }) => id === key.slice(0, key.indexOf("\u0000"))))
          next.delete(key);
      return next;
    });
    const identity = externalNotificationPublishIdentity(input.state, input.projectWork);
    const payload = buildExternalNotificationPayload({ ...input, appScheme, test: false });
    const safePayload =
      contentGuard._tag === "None"
        ? payload
        : ((yield* contentGuard.value.redact(payload)).value as ExternalNotificationPayload);
    const outcomeRef = yield* Ref.make<Array<ExternalNotificationDestinationOutcome>>([]);
    yield* Effect.forEach(
      selectedDestinations,
      (destination) => {
        const key = `${destination.id}\u0000${input.threadId}`;
        return Effect.gen(function* () {
          if (
            !(input.bypassMemoryDedup || input.bypassLegacyDedup) &&
            (yield* Ref.get(identities)).get(key) === identity
          ) {
            yield* Ref.update(outcomeRef, (items) => [
              ...items,
              { destinationId: destination.id, status: "delivered" as const },
            ]);
            return;
          }
          yield* compileAdapter(destination)(safePayload).pipe(
            Effect.tap(() =>
              Effect.all([
                Ref.update(identities, (current) => new Map(current).set(key, identity)),
                Ref.update(outcomeRef, (items) => [
                  ...items,
                  { destinationId: destination.id, status: "delivered" as const },
                ]),
              ]).pipe(Effect.asVoid),
            ),
            Effect.catch((error) =>
              logFailure(error, destination.id).pipe(
                Effect.andThen(
                  Ref.update(outcomeRef, (items) => [
                    ...items,
                    {
                      destinationId: destination.id,
                      status: "failed" as const,
                      reason: Schema.is(ExternalNotificationError)(error)
                        ? error.reason
                        : "transport",
                    },
                  ]),
                ),
              ),
            ),
          );
        });
      },
      { concurrency: MAX_DESTINATION_CONCURRENCY, discard: true },
    );
    const outcomes = yield* Ref.get(outcomeRef);
    const deliveredDestinationIds = outcomes
      .filter((outcome) => outcome.status === "delivered")
      .map((outcome) => outcome.destinationId)
      .toSorted();
    const failedDestinationIds = outcomes
      .filter((outcome) => outcome.status === "failed")
      .map((outcome) => outcome.destinationId)
      .toSorted();
    return {
      attemptedDestinationIds: [...activeIds].toSorted(),
      deliveredDestinationIds,
      failedDestinationIds,
      outcomes: outcomes.toSorted((left, right) =>
        left.destinationId.localeCompare(right.destinationId),
      ),
    } satisfies ExternalNotificationDispatchResult;
  });
  const dispatch: ExternalNotificationDispatcherShape["dispatch"] = (input) =>
    dispatchSemaphore
      .withPermits(1)(dispatchUnsafe(input))
      .pipe(Effect.orElseSucceed(() => emptyDispatchResult()));
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
  return ExternalNotificationDispatcher.of({
    dispatch,
    dispatchDetailed: dispatch,
    hasEnabledDestinations,
    test,
  });
});

export const layer = Layer.effect(ExternalNotificationDispatcher, make);
export const layerTest = Layer.succeed(ExternalNotificationDispatcher, {
  dispatch: () => Effect.succeed(emptyDispatchResult()),
  dispatchDetailed: () => Effect.succeed(emptyDispatchResult()),
  hasEnabledDestinations: Effect.succeed(false),
  test: (destinationId) =>
    Effect.fail(new ExternalNotificationError({ destinationId, reason: "not-configured" })),
} satisfies ExternalNotificationDispatcherShape);
