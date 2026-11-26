import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import { SELF_HOSTED_RELAY_HOOK_PROOF_TYP } from "@t3tools/contracts/selfHostedRelayHooks";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { decodeRelayJwt, signRelayJwt } from "./relayJwt.ts";
import {
  signSelfHostedRelayHookDelivery,
  verifySelfHostedRelayHookDelivery,
} from "./selfHostedRelayHookProof.ts";

const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject));

const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(1_000_000);
  const keys = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const privateKey = yield* Jwk.importPrivate(keys.privateKey, "EdDSA");
  const publicKey = yield* Jwk.importPublic(keys.publicKey, "EdDSA");
  const delivery = {
    relayId: SelfHostedRelayId.make("self-hosted-relay"),
    environmentId: EnvironmentId.make("env-1"),
    hookId: "id",
    deliveryId: "delivery-1",
    receivedAt: "1970-01-01T00:15:40.000Z",
    method: "POST",
    rawTarget: "/api/relay-hooks/id/tok?x=%2f&x=+",
    body: new Uint8Array([255, 10, 0, 13]),
    headers: {
      "x-sender-signature": "sha256=exact",
      authorization: "sha256=sender-signature",
      "x-sender-event-id": "event-1",
    },
  } as const;
  return { delivery, privateKey, publicKey };
});

describe("self-hosted relay hook proof", () => {
  it.effect("distinguishes invalid signing input from unavailable signing", () =>
    Effect.gen(function* () {
      const { delivery, privateKey } = yield* fixture;
      const invalidTarget = yield* Effect.flip(
        signSelfHostedRelayHookDelivery({
          ...delivery,
          privateKey,
          rawTarget: `${delivery.rawTarget}#fragment`,
        }),
      );
      const unavailableSigner = yield* Effect.flip(
        signSelfHostedRelayHookDelivery({ ...delivery, privateKey: "invalid key" }),
      );
      expect(invalidTarget._tag).toBe("InvalidSelfHostedRelayHookProof");
      expect(unavailableSigner._tag).toBe("SelfHostedRelayHookSigningUnavailable");
      expect("cause" in unavailableSigner).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("binds the proof to the intended relay, recipient, and request", () =>
    Effect.gen(function* () {
      const { delivery, privateKey, publicKey } = yield* fixture;
      const token = yield* signSelfHostedRelayHookDelivery({ ...delivery, privateKey });
      const input = { ...delivery, publicKey, token };

      expect(yield* verifySelfHostedRelayHookDelivery(input)).toEqual({
        relayIssuer: delivery.relayId,
        deliveryId: delivery.deliveryId,
        receivedAt: delivery.receivedAt,
        headers: delivery.headers,
      });
      const changes = {
        issuer: { relayId: SelfHostedRelayId.make("another-relay") },
        recipient: { environmentId: EnvironmentId.make("another-env") },
        hook: { hookId: "other" },
        method: { method: "PUT" },
        body: { body: new Uint8Array([255, 10, 0, 10]) },
        headerValue: { headers: { ...delivery.headers, "x-sender-signature": "sha256=other" } },
        missingHeader: { headers: { "x-sender-event-id": "event-1" } },
      };
      for (const [name, change] of Object.entries(changes)) {
        const error = yield* Effect.flip(
          verifySelfHostedRelayHookDelivery({ ...input, ...change }),
        );
        expect(error._tag, name).toBe("InvalidSelfHostedRelayHookProof");
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("rejects malformed, mutated, and expired claims", () =>
    Effect.gen(function* () {
      const { delivery, privateKey, publicKey } = yield* fixture;
      const token = yield* signSelfHostedRelayHookDelivery({ ...delivery, privateKey });
      const input = { ...delivery, publicKey, token };
      const claims = yield* decodeRelayJwt(token);
      const jsonClaims = yield* encodeClaims(claims);
      const duplicateClaim = yield* Jws.sign(
        new TextEncoder().encode(`{"version":2,${jsonClaims.slice(1)}`),
        privateKey,
        { typ: SELF_HOSTED_RELAY_HOOK_PROOF_TYP },
      ).pipe(Effect.map(Redacted.value));
      const signClaims = (overrides: Record<string, unknown>) =>
        signRelayJwt({
          privateKey,
          typ: SELF_HOSTED_RELAY_HOOK_PROOF_TYP,
          payload: { ...claims, ...overrides },
        });
      const [protectedHeader, , signature] = token.split(".");
      const replaceClaims = (overrides: typeof claims) =>
        encodeClaims({ ...claims, ...overrides }).pipe(
          Effect.map((json) => `${protectedHeader}.${Base64Url.encode(json)}.${signature}`),
        );
      const malformed = {
        token: "malformed",
        extraClaim: yield* signClaims({ extra: "unsupported" }),
        duplicateClaim,
        version: yield* signClaims({ version: 2 }),
        duplicateHeaders: yield* signClaims({
          headerNames: [
            "authorization",
            "x-sender-event-id",
            "x-sender-event-id",
            "x-sender-signature",
          ],
        }),
        deliveryId: yield* replaceClaims({ deliveryId: "substituted" }),
        receivedAt: yield* replaceClaims({ receivedAt: "2026-01-01T00:00:00.000Z" }),
      };
      for (const [name, token] of Object.entries(malformed)) {
        const error = yield* Effect.flip(verifySelfHostedRelayHookDelivery({ ...input, token }));
        expect(error._tag, name).toBe("InvalidSelfHostedRelayHookProof");
      }

      yield* TestClock.adjust("420 seconds");
      const expired = yield* Effect.flip(verifySelfHostedRelayHookDelivery(input));
      expect(expired._tag).toBe("InvalidSelfHostedRelayHookProof");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
