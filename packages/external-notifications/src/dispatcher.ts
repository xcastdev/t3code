import {
  DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
  type ExternalNotificationDestination,
  type ExternalNotificationEvent,
  type ExternalNotificationTestEvent,
  type ExternalNotificationTestResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ExternalNotificationError, WebhookEvent } from "./adapter.ts";

export interface ExternalNotificationClaim {
  readonly environmentId: string;
  readonly occurrenceId: string;
  readonly destinationId: string;
  readonly legacyIdentity?: string;
}

export type ExternalNotificationDeliveryStatus = "delivered" | "failed" | "uncertain";

export function makeExternalNotificationDispatcher<
  ReadError,
  ClaimError,
  RecordError,
  SendServices,
>(dependencies: {
  readonly readDestinations: (
    environmentId: string,
  ) => Effect.Effect<ReadonlyArray<ExternalNotificationDestination>, ReadError>;
  readonly claim: (key: ExternalNotificationClaim) => Effect.Effect<boolean, ClaimError>;
  readonly record: (
    key: ExternalNotificationClaim,
    status: ExternalNotificationDeliveryStatus,
  ) => Effect.Effect<void, RecordError>;
  readonly send: (
    destination: ExternalNotificationDestination,
    event: WebhookEvent,
  ) => Effect.Effect<void, ExternalNotificationError, SendServices>;
}) {
  const dispatch = Effect.fn("ExternalNotificationDispatcher.dispatch")(function* (
    event: ExternalNotificationEvent,
    options?: {
      readonly legacyIdentity?: string;
      readonly destinationKind?: ExternalNotificationDestination["kind"];
      readonly liveOnly?: boolean;
    },
  ) {
    const { legacyIdentity, destinationKind, liveOnly } = options ?? {};
    const destinations = yield* dependencies.readDestinations(event.environmentId);
    for (const destination of destinations) {
      const usesLegacyFilters =
        destination.kind === "home-assistant" && destination.events === undefined;
      if (
        (destinationKind !== undefined && destination.kind !== destinationKind) ||
        (liveOnly && usesLegacyFilters) ||
        !destination.enabled ||
        !destination.webhookUrl ||
        !(destination.events ?? DEFAULT_EXTERNAL_NOTIFICATION_EVENTS).includes(event.eventType)
      ) {
        continue;
      }
      const key: ExternalNotificationClaim = {
        environmentId: event.environmentId,
        occurrenceId: event.occurrenceId,
        destinationId: destination.id,
        ...(legacyIdentity === undefined ? {} : { legacyIdentity }),
      };
      yield* Effect.gen(function* () {
        if (!(yield* dependencies.claim(key))) return;
        const status = yield* dependencies.send(destination, event).pipe(
          Effect.match({
            onSuccess: (): ExternalNotificationDeliveryStatus => "delivered",
            onFailure: (error): ExternalNotificationDeliveryStatus =>
              !error.knownFailure && (error.reason === "transport" || error.reason === "timeout")
                ? "uncertain"
                : "failed",
          }),
        );
        yield* dependencies.record(key, status);
      }).pipe(Effect.ignoreCause);
    }
  });

  const test = Effect.fn("ExternalNotificationDispatcher.test")(
    function* (
      destinationId: string,
      sampleEvent: ExternalNotificationTestEvent,
    ): Effect.fn.Return<ExternalNotificationTestResult, ReadError, SendServices> {
      const destinations = yield* dependencies.readDestinations(sampleEvent.environmentId);
      const destination = destinations.find((entry) => entry.id === destinationId);
      if (!destination?.webhookUrl) return { status: "failed", reason: "unconfigured" };
      return yield* dependencies.send(destination, sampleEvent).pipe(
        Effect.match({
          onSuccess: () => ({ status: "delivered" as const }),
          onFailure: (error) => ({ status: "failed" as const, reason: error.reason }),
        }),
      );
    },
    Effect.catchCause(() => Effect.succeed({ status: "failed", reason: "transport" } as const)),
  );

  return { dispatch, test };
}
