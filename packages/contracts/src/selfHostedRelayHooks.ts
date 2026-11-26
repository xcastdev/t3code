import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SelfHostedRelayId } from "./selfHostedRelay.ts";

export const SELF_HOSTED_RELAY_HOOK_INGRESS_PATH = "/api/hooks/:environmentId/:hookId/:token";
export const SELF_HOSTED_RELAY_HOOK_POLICY_PATH =
  "/api/self-hosted-relay/v1/hooks/:environmentId/:hookId";
export const SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES = 1024 * 1024;
export const SELF_HOSTED_RELAY_HOOK_DELIVERY_PATH = "/api/relay-hooks/:hookId/:token";
export const SELF_HOSTED_RELAY_HOOK_PROOF_HEADER = "x-t3-self-hosted-hook-proof";
export const SELF_HOSTED_RELAY_HOOK_PROOF_TYP = "t3-self-hosted-hook-delivery-v1+jwt";

export const SelfHostedRelayHookMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH"]);
export type SelfHostedRelayHookMethod = typeof SelfHostedRelayHookMethod.Type;

const hookId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => value !== "." && value !== ".." && !/[\uD800-\uDFFF]/u.test(value)),
);
export const SelfHostedRelayHookTarget = Schema.Struct({ environmentId: EnvironmentId, hookId });
export type SelfHostedRelayHookTarget = typeof SelfHostedRelayHookTarget.Type;
export const SelfHostedRelayHookPolicy = Schema.Struct({
  ...SelfHostedRelayHookTarget.fields,
  enabled: Schema.Boolean,
  holdEnabled: Schema.Boolean,
});
export type SelfHostedRelayHookPolicy = typeof SelfHostedRelayHookPolicy.Type;
export const SelfHostedRelayHookPolicyV1 = Schema.Struct({
  version: Schema.Literal(1),
  ...SelfHostedRelayHookPolicy.fields,
});
export type SelfHostedRelayHookPolicyV1 = typeof SelfHostedRelayHookPolicyV1.Type;
export const SelfHostedRelayHookPolicyResult = Schema.NullOr(SelfHostedRelayHookPolicyV1);

const transportHeaders = new Set([
  "connection",
  "content-length",
  "cookie",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function isSelfHostedRelayHookApplicationHeader(name: string): boolean {
  return (
    /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/u.test(name) &&
    !transportHeaders.has(name) &&
    !name.startsWith("x-forwarded-") &&
    !name.startsWith("x-t3-relay-") &&
    !name.startsWith("x-t3-self-hosted-")
  );
}

const sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const isoUtcMillis = Schema.String.check(
  Schema.makeFilter((value) => {
    const time = DateTime.make(value);
    return Option.isSome(time) && DateTime.formatIso(time.value) === value;
  }),
);
const headerNames = Schema.Array(Schema.String).check(
  Schema.makeFilter((names) =>
    names.every(
      (name, index) =>
        isSelfHostedRelayHookApplicationHeader(name) &&
        (index === 0 || (names[index - 1] ?? "") < name),
    ),
  ),
);

export const SelfHostedRelayHookRawTarget = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.isPattern(/^\/api\/relay-hooks\/[^/?#\s]+\/[^/?#\s]+(?:\?[^#\s]*)?$/u),
);

export const SelfHostedRelayHookDeliveryProof = Schema.Struct({
  version: Schema.Literal(1),
  iss: SelfHostedRelayId,
  aud: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sub: EnvironmentId,
  iat: Schema.Int,
  exp: Schema.Int,
  environmentId: EnvironmentId,
  hookId,
  deliveryId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  receivedAt: isoUtcMillis,
  method: SelfHostedRelayHookMethod,
  rawTarget: SelfHostedRelayHookRawTarget,
  bodySha256: sha256,
  headerNames,
  headersSha256: sha256,
});
