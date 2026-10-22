import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Settings from "../serverSettings.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Adapter from "../notifications/HomeAssistantWebhookAdapter.ts";
import * as Dispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import * as Gateway from "../notifications/ExternalNotificationGateway.ts";
import * as Runtime from "../notifications/ExternalNotificationRuntime.ts";

export const controlledNotificationDestinationId = "p21-fixture-notification";
type Receipt = {
  readonly kind: Adapter.ExternalNotificationPayload["kind"];
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
          Context.add(Adapter.HomeAssistantWebhookAdapter, {
            send: (url, payload) =>
              url !== webhookUrl
                ? Effect.fail(new Adapter.ExternalNotificationError({ reason: "unconfigured" }))
                : Ref.update(received, (current) => [
                    ...current.slice(-63),
                    { kind: payload.kind, test: payload.test },
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
