import type { ExternalNotificationEvent, ExternalNotificationTestResult } from "@t3tools/contracts";
import { makeExternalNotificationDispatcher } from "@t3tools/external-notifications/dispatcher";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Transport from "./ExternalNotificationTransport.ts";

type WithoutEnvironment<Event> = Event extends ExternalNotificationEvent
  ? Omit<Event, "environmentId" | "environmentName"> & {
      readonly legacyIdentity?: string;
      readonly liveOnly?: boolean;
    }
  : never;

export type ExternalNotificationFact = WithoutEnvironment<ExternalNotificationEvent>;

type Pending = {
  readonly event: ExternalNotificationEvent;
  readonly liveOnly: boolean;
  readonly legacyIdentity?: string;
};

export class ExternalNotificationDispatcher extends Context.Service<
  ExternalNotificationDispatcher,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly notifyCommitted: (fact: ExternalNotificationFact) => Effect.Effect<void>;
    readonly test: (destinationId: string) => Effect.Effect<ExternalNotificationTestResult>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/notifications/ExternalNotificationDispatcher") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const name =
    environment.getLabel ?? environment.getDescriptor.pipe(Effect.map(({ label }) => label));
  const source = name.pipe(
    Effect.map((label) => ({ environmentId, environmentName: label.trim() || environmentId })),
  );
  const { send } = yield* Transport.ExternalNotificationTransport;
  const dispatcher = makeExternalNotificationDispatcher({
    readDestinations: (sourceId) =>
      sourceId === environmentId
        ? settings.withSettingsSnapshot((config) =>
            Effect.succeed(config.externalNotifications.destinations),
          )
        : Effect.succeed([]),
    claim: ({ environmentId, occurrenceId, destinationId, legacyIdentity }) =>
      // The alias check and insertion share one SQLite write transaction.
      sql`INSERT INTO t3_workflow_v2_external_notification_occurrences
          (environment_id,occurrence_id,destination_id,status)
        SELECT ${environmentId},${occurrenceId},${destinationId},'uncertain'
        WHERE NOT EXISTS (
          SELECT 1 FROM t3_workflow_v2_external_notifications
          WHERE fact_id=${legacyIdentity ?? null} AND destination_id=${destinationId}
        )
        ON CONFLICT DO NOTHING RETURNING occurrence_id`.pipe(Effect.map((rows) => rows.length > 0)),
    record: ({ environmentId, occurrenceId, destinationId }, status) =>
      sql`UPDATE t3_workflow_v2_external_notification_occurrences SET status=${status}
        WHERE environment_id=${environmentId} AND occurrence_id=${occurrenceId}
          AND destination_id=${destinationId}`.pipe(Effect.asVoid),
    send,
  });
  const homeAssistant = yield* Queue.dropping<Pending>(128);
  const generic = yield* Queue.dropping<Pending>(64);
  // Keep legacy capacity reserved while all Home Assistant sends share one FIFO.
  const legacySlots = yield* Semaphore.make(64);
  const liveSlots = yield* Semaphore.make(64);
  const queues = [
    [homeAssistant, "home-assistant"],
    [generic, "generic-webhook"],
  ] as const;
  const started = yield* Ref.make(false);
  const dispatch = Effect.fn("ExternalNotificationDispatcher.dispatchPending")(function* (
    { event, ...options }: Pending,
    destinationKind: (typeof queues)[number][1],
  ) {
    if (destinationKind === "home-assistant") {
      yield* (options.liveOnly ? liveSlots : legacySlots).release(1);
    }
    yield* dispatcher.dispatch(event, { ...options, destinationKind }).pipe(Effect.ignoreCause);
  });
  const offerHomeAssistant = Effect.fn("ExternalNotificationDispatcher.offerHomeAssistant")(
    function* (pending: Pending) {
      const slots = pending.liveOnly ? liveSlots : legacySlots;
      if (!(yield* slots.takeIfAvailable(1))) return;
      if (!(yield* Queue.offer(homeAssistant, pending))) yield* slots.release(1);
    },
    Effect.uninterruptible,
  );

  return ExternalNotificationDispatcher.of({
    start: Effect.gen(function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      for (const [queue, selection] of queues) {
        yield* Queue.take(queue).pipe(
          Effect.flatMap((pending) => dispatch(pending, selection)),
          Effect.forever,
          Effect.forkScoped,
        );
      }
    }),
    notifyCommitted: Effect.fn("ExternalNotificationDispatcher.notifyCommitted")(function* ({
      legacyIdentity,
      liveOnly,
      ...fact
    }: ExternalNotificationFact) {
      const origin = yield* source;
      const pending: Pending = {
        event: { ...fact, ...origin },
        liveOnly: liveOnly === true,
        ...(legacyIdentity === undefined ? {} : { legacyIdentity }),
      };
      yield* Queue.offer(generic, pending);
      yield* offerHomeAssistant(pending);
    }),
    test: Effect.fn("ExternalNotificationDispatcher.test")(
      function* (destinationId: string) {
        return yield* dispatcher.test(destinationId, {
          ...(yield* source),
          eventType: "test",
          occurrenceId: yield* random.uuidV4(),
          timestamp: DateTime.formatIso(yield* DateTime.now),
          title: "T3 Code test notification",
        });
      },
      Effect.catchCause(() => Effect.succeed({ status: "failed", reason: "transport" } as const)),
    ),
    drain: Effect.forEach(
      queues,
      ([queue, selection]) =>
        Queue.clear(queue).pipe(
          Effect.flatMap((facts) =>
            Effect.forEach(facts, (pending) => dispatch(pending, selection), { discard: true }),
          ),
        ),
      { discard: true },
    ),
  });
});
export const layer = Layer.effect(ExternalNotificationDispatcher, make).pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
);
