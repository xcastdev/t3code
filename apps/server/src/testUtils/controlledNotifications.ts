import { DEFAULT_EXTERNAL_NOTIFICATION_EVENTS } from "@t3tools/contracts";
import { ExternalNotificationError } from "@t3tools/external-notifications/webhook";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Settings from "../serverSettings.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Transport from "../notifications/ExternalNotificationTransport.ts";
import * as Dispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import * as Gateway from "../notifications/ExternalNotificationGateway.ts";
import * as Runtime from "../notifications/ExternalNotificationRuntime.ts";

export const controlledNotificationDestinationId = "p21-fixture-notification";
type Receipt = {
  readonly kind: "notification" | "work-attention" | "test";
  readonly test: boolean;
};
export class ControlledNotificationReceipts extends Context.Service<
  ControlledNotificationReceipts,
  { readonly received: Effect.Effect<ReadonlyArray<Receipt>> }
>()("t3/testUtils/controlledNotifications/ControlledNotificationReceipts") {}

/** Settings, credentials and receipts are new in-memory fixture state; the adapter has no HTTP port. */
export const layerControlledNotificationPorts = Layer.unwrap(
  Effect.gen(function* () {
    const secrets = yield* Secrets.ServerSecretStore;
    const credential = yield* secrets.getOrCreateRandom("controlled-notification-credential", 32);
    const token = Array.from(credential, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const webhookUrl = `https://p21-fixture.invalid/api/webhook/${token}`;
    const adapter = Layer.effectContext(
      Effect.gen(function* () {
        const received = yield* Ref.make<ReadonlyArray<Receipt>>([]);
        return Context.make(ControlledNotificationReceipts, { received: Ref.get(received) }).pipe(
          Context.add(Transport.ExternalNotificationTransport, {
            send: (destination, event) =>
              destination.webhookUrl !== webhookUrl
                ? Effect.fail(new ExternalNotificationError({ reason: "unconfigured" }))
                : Ref.update(received, (current): ReadonlyArray<Receipt> => [
                    ...current.slice(-63),
                    {
                      kind:
                        event.eventType === "test" || event.eventType === "work-attention"
                          ? event.eventType
                          : "notification",
                      test: event.eventType === "test",
                    },
                  ]),
          }),
        );
      }),
    );
    return Layer.mergeAll(
      adapter,
      Settings.layerTest({
        continueThreadsAfterServerUpdate: false,
        externalNotifications: {
          destinations: [
            {
              id: controlledNotificationDestinationId,
              name: "Controlled fixture",
              kind: "home-assistant",
              enabled: false,
              events: DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
              webhookUrl,
            },
          ],
        },
      }),
    );
  }),
);

export const layerControlledNotifications = Gateway.layer.pipe(
  Layer.provideMerge(Dispatcher.layer),
);
export const layerControlledNotificationRuntime = Layer.effectDiscard(
  Effect.flatMap(Runtime.ExternalNotificationRuntime, (runtime) => runtime.start),
).pipe(Layer.provideMerge(Runtime.layer));
