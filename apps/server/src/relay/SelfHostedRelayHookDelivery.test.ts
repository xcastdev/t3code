// @effect-diagnostics nodeBuiltinImport:off -- Generate a signing key for the forwarding boundary fixture.
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as Forwarding from "@t3tools/relay-core/RelayForwarding";
import * as Effect from "effect/Effect";

import * as Delivery from "./SelfHostedRelayHookDelivery.ts";

it.effect.each([
  ["publisher-offline", false],
  ["closed", true],
] as const)(
  "preserves delivery certainty on %s forwarding failures",
  ([reason, possiblyAdmitted]) =>
    Effect.gen(function* () {
      const { privateKey } = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const result = yield* Delivery.deliver(privateKey, {
        relayId: SelfHostedRelayId.make("relay"),
        environmentId: EnvironmentId.make("environment"),
        hookId: "hook",
        deliveryId: "delivery",
        receivedAt: "1970-01-01T00:00:00.000Z",
        method: "PATCH",
        rawTarget: "/api/relay-hooks/hook/token",
        headers: {},
        body: Uint8Array.of(1, 2, 3),
      }).pipe(
        Effect.provideService(Forwarding.RelayForwarding, {
          openPublisher: () => Effect.die("unexpected publisher"),
          forward: () => Effect.die("unexpected forward"),
          deliverHook: () =>
            Effect.fail(new Forwarding.RelayForwardingUnavailableError({ reason })),
        }),
      );
      assert.deepEqual(result, { kind: "retry", status: 503, possiblyAdmitted });
    }).pipe(Effect.provide(NodePlatformCrypto.layer)),
);
