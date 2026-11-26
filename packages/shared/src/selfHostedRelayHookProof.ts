import type { EnvironmentId } from "@t3tools/contracts";
import type { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import {
  SELF_HOSTED_RELAY_HOOK_PROOF_TYP,
  SelfHostedRelayHookDeliveryProof,
  type SelfHostedRelayHookMethod,
} from "@t3tools/contracts/selfHostedRelayHooks";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as JoseError from "effect/jose/JoseError";
import type * as Jwk from "effect/jose/Jwk";
import * as Schema from "effect/Schema";

import { signRelayJwt, verifyRelayJwt } from "./relayJwt.ts";

const proofLifetimeSeconds = 300;
const maxProofLength = 16 * 1024;
const encoder = new TextEncoder();
const decodeProof = Schema.decodeUnknownEffect(SelfHostedRelayHookDeliveryProof);
const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject));
const strict = { onExcessProperty: "error" } as const;

export class InvalidSelfHostedRelayHookProof extends Schema.TaggedError<InvalidSelfHostedRelayHookProof>()(
  "InvalidSelfHostedRelayHookProof",
  {},
) {
  override get message(): string {
    return "Invalid self-hosted relay hook proof.";
  }
}

export class SelfHostedRelayHookSigningUnavailable extends Schema.TaggedError<SelfHostedRelayHookSigningUnavailable>()(
  "SelfHostedRelayHookSigningUnavailable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Self-hosted relay hook signing unavailable.";
  }
}

export class SelfHostedRelayHookVerificationUnavailable extends Schema.TaggedError<
  SelfHostedRelayHookVerificationUnavailable,
  { readonly brand: unique symbol }
>()("SelfHostedRelayHookVerificationUnavailable", { cause: Schema.Defect() }) {
  override get message(): string {
    return "Self-hosted relay hook verification unavailable.";
  }
}

interface HookDelivery {
  readonly environmentId: EnvironmentId;
  readonly hookId: string;
  readonly method: string;
  readonly rawTarget: string;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

const headerDigest = (
  digest: Digest.Digest["Service"],
  headers: Readonly<Record<string, string>>,
) =>
  digest.digestHex(
    Digest.sha256,
    encoder.encode(
      JSON.stringify(
        Object.keys(headers)
          .sort()
          .map((name) => [name, headers[name]]),
      ),
    ),
  );

export const signSelfHostedRelayHookDelivery = Effect.fn("selfHostedRelayHook.signDelivery")(
  function* (
    input: HookDelivery & {
      readonly privateKey: string | Jwk.PrivateKey;
      readonly relayId: SelfHostedRelayId;
      readonly deliveryId: string;
      readonly receivedAt: string;
      readonly method: SelfHostedRelayHookMethod;
    },
  ) {
    const digest = yield* Digest.Digest;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const payload = yield* decodeProof(
      {
        version: 1,
        iss: input.relayId,
        aud: `t3-env:${input.environmentId}`,
        sub: input.environmentId,
        iat: now,
        exp: now + proofLifetimeSeconds,
        environmentId: input.environmentId,
        hookId: input.hookId,
        deliveryId: input.deliveryId,
        receivedAt: input.receivedAt,
        method: input.method,
        rawTarget: input.rawTarget,
        bodySha256: yield* digest.digestHex(Digest.sha256, input.body),
        headerNames: Object.keys(input.headers).sort(),
        headersSha256: yield* headerDigest(digest, input.headers),
      },
      strict,
    ).pipe(Effect.mapError(() => new InvalidSelfHostedRelayHookProof()));
    const token = yield* signRelayJwt({
      privateKey: input.privateKey,
      typ: SELF_HOSTED_RELAY_HOOK_PROOF_TYP,
      payload,
    }).pipe(Effect.mapError((cause) => new SelfHostedRelayHookSigningUnavailable({ cause })));
    if (token.length > maxProofLength) return yield* new InvalidSelfHostedRelayHookProof();
    return token;
  },
);

export const verifySelfHostedRelayHookDelivery = Effect.fn("selfHostedRelayHook.verifyDelivery")(
  function* (
    input: HookDelivery & {
      readonly publicKey: string | Jwk.PublicKey;
      readonly relayId: SelfHostedRelayId;
      readonly token: string;
    },
  ) {
    if (input.token.length > maxProofLength) return yield* new InvalidSelfHostedRelayHookProof();

    const claims = yield* verifyRelayJwt(Schema.JsonObject, {
      token: input.token,
      publicKey: input.publicKey,
      issuer: input.relayId,
      audience: `t3-env:${input.environmentId}`,
      typ: SELF_HOSTED_RELAY_HOOK_PROOF_TYP,
    }).pipe(
      Effect.mapError((cause) =>
        // JWS wraps provider failures as InvalidKey and reports a false verification separately.
        JoseError.isJoseError(cause.cause) && cause.cause.reason._tag === "InvalidKey"
          ? new SelfHostedRelayHookVerificationUnavailable({ cause })
          : new InvalidSelfHostedRelayHookProof(),
      ),
    );
    // The signer emits compact JSON. A round trip rejects duplicate claim keys lost by JSON.parse.
    const encodedClaims = yield* encodeClaims(claims).pipe(
      Effect.mapError(() => new InvalidSelfHostedRelayHookProof()),
    );
    if (input.token.split(".")[1] !== Base64Url.encode(encodedClaims)) {
      return yield* new InvalidSelfHostedRelayHookProof();
    }
    const proof = yield* decodeProof(claims, strict).pipe(
      Effect.mapError(() => new InvalidSelfHostedRelayHookProof()),
    );
    if (
      proof.exp !== proof.iat + proofLifetimeSeconds ||
      proof.sub !== input.environmentId ||
      proof.environmentId !== input.environmentId ||
      proof.hookId !== input.hookId ||
      proof.method !== input.method ||
      proof.rawTarget !== input.rawTarget
    ) {
      return yield* new InvalidSelfHostedRelayHookProof();
    }

    const entries: Array<readonly [string, string]> = [];
    for (const name of proof.headerNames) {
      const value = input.headers[name];
      if (value === undefined || !Object.hasOwn(input.headers, name)) {
        return yield* new InvalidSelfHostedRelayHookProof();
      }
      entries.push([name, value]);
    }
    const headers = Object.fromEntries(entries);
    const digest = yield* Digest.Digest;
    if (
      proof.bodySha256 !== (yield* digest.digestHex(Digest.sha256, input.body)) ||
      proof.headersSha256 !== (yield* headerDigest(digest, headers))
    ) {
      return yield* new InvalidSelfHostedRelayHookProof();
    }
    return {
      relayIssuer: proof.iss,
      deliveryId: proof.deliveryId,
      receivedAt: proof.receivedAt,
      headers,
    };
  },
);
