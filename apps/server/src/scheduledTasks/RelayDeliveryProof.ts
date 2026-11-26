import type { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import { SELF_HOSTED_RELAY_HOOK_PROOF_HEADER } from "@t3tools/contracts/selfHostedRelayHooks";
import {
  InvalidSelfHostedRelayHookProof,
  type SelfHostedRelayHookVerificationUnavailable,
  verifySelfHostedRelayHookDelivery,
} from "@t3tools/shared/selfHostedRelayHookProof";
import { RelayHookDeliveryProofPayload } from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HOOK_DELIVERY_HEADER,
  RELAY_HOOK_DELIVERY_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import type * as Jwk from "effect/jose/Jwk";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** Covers the relay's 24-hour hold plus a margin. */
const MAX_PROOF_AGE = "25 hours";

const text = (bytes: Option.Option<Uint8Array>) =>
  Option.map(bytes, (value) => new TextDecoder().decode(value));

export class SelfHostedRelayHookAuthority extends Context.Reference<{
  readonly relayId: SelfHostedRelayId;
  readonly publicKey: string | Jwk.PublicKey;
} | null>("t3/scheduledTasks/SelfHostedRelayHookAuthority", { defaultValue: () => null }) {}

export class RelayDeliveryProof extends Context.Service<
  RelayDeliveryProof,
  {
    readonly verifyHosted: (input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly hookId: string;
    }) => Effect.Effect<
      Option.Option<{
        readonly relayIssuer: string;
        readonly deliveryId: string;
        readonly receivedAt: string;
      }>
    >;
    readonly verifySelfHosted: (input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly hookId: string;
      readonly method: string;
      readonly rawTarget: string;
      readonly body: Uint8Array;
    }) => Effect.Effect<
      {
        readonly relayIssuer: SelfHostedRelayId;
        readonly deliveryId: string;
        readonly receivedAt: string;
        readonly headers: Readonly<Record<string, string>>;
      },
      InvalidSelfHostedRelayHookProof | SelfHostedRelayHookVerificationUnavailable
    >;
  }
>()("t3/scheduledTasks/RelayDeliveryProof") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const signature = yield* Signature.Signature;
  const digest = yield* Digest.Digest;
  const authority = yield* SelfHostedRelayHookAuthority;
  const verifyHosted: RelayDeliveryProof["Service"]["verifyHosted"] = Effect.fn(
    "webhook.verifyRelayDelivery",
  )(function* (input) {
    const proof = input.headers[RELAY_HOOK_DELIVERY_HEADER];
    const deliveryId = input.headers["x-t3-relay-delivery-id"];
    const receivedAt = input.headers["x-t3-relay-received-at"];
    if (proof === undefined || deliveryId === undefined || receivedAt === undefined) {
      return Option.none();
    }
    const publicKey = text(yield* secrets.get(CLOUD_MINT_PUBLIC_KEY));
    const issuer = text(yield* secrets.get(RELAY_ISSUER_SECRET));
    const relayUrl = text(yield* secrets.get(RELAY_URL_SECRET));
    const relayIssuer = Option.isSome(issuer) ? issuer : relayUrl;
    if (Option.isNone(publicKey) || Option.isNone(relayIssuer)) return Option.none();
    const environmentId = yield* environment.getEnvironmentId;
    const normalizedIssuer = normalizeRelayIssuer(relayIssuer.value);
    const payload = yield* verifyRelayJwt(RelayHookDeliveryProofPayload, {
      publicKey: publicKey.value,
      token: proof,
      typ: RELAY_HOOK_DELIVERY_TYP,
      issuer: normalizedIssuer,
      audience: `t3-env:${environmentId}`,
      maxTokenAge: MAX_PROOF_AGE,
    }).pipe(Effect.provideService(Signature.Signature, signature), Effect.option);
    // The proof must name exactly this delivery, so it cannot be lifted onto another one.
    if (
      Option.isNone(payload) ||
      payload.value.environmentId !== environmentId ||
      payload.value.deliveryId !== deliveryId ||
      payload.value.receivedAt !== receivedAt ||
      payload.value.hookId !== input.hookId
    ) {
      return Option.none();
    }
    return Option.some({ relayIssuer: normalizedIssuer, deliveryId, receivedAt });
  }, Effect.orElseSucceed(Option.none));
  const verifySelfHosted: RelayDeliveryProof["Service"]["verifySelfHosted"] = Effect.fn(
    "webhook.verifySelfHostedRelayDelivery",
  )(function* (input) {
    const token = input.headers[SELF_HOSTED_RELAY_HOOK_PROOF_HEADER];
    if (authority === null || token === undefined) {
      return yield* new InvalidSelfHostedRelayHookProof();
    }
    const environmentId = yield* environment.getEnvironmentId;
    return yield* verifySelfHostedRelayHookDelivery({
      ...input,
      ...authority,
      token,
      environmentId,
    }).pipe(
      Effect.provideService(Signature.Signature, signature),
      Effect.provideService(Digest.Digest, digest),
    );
  });
  return RelayDeliveryProof.of({ verifyHosted, verifySelfHosted });
});

export const layer = Layer.effect(RelayDeliveryProof, make);
