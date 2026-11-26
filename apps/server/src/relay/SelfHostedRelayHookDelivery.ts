import { SELF_HOSTED_RELAY_HOOK_PROOF_HEADER } from "@t3tools/contracts/selfHostedRelayHooks";
import type {
  RelayHookDelivery,
  RelayHookDeliveryResult,
} from "@t3tools/relay-core/RelayHookIngress";
import * as Forwarding from "@t3tools/relay-core/RelayForwarding";
import { signSelfHostedRelayHookDelivery } from "@t3tools/shared/selfHostedRelayHookProof";
import * as Effect from "effect/Effect";

const unsent = { kind: "retry", status: 503, possiblyAdmitted: false } as const;
const unconfirmed = { ...unsent, possiblyAdmitted: true } as const;

function parseRetryAfter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{1,10}$/u.test(value)) return value;
  if (
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return value;
  return undefined;
}

function deliveryResult(reply: {
  readonly status: number;
  readonly outcome?: string;
  readonly retryAfter?: string;
}): RelayHookDeliveryResult {
  const { status, outcome } = reply;
  switch (outcome) {
    case "accepted":
    case "filtered":
    case "prompt_too_long":
    case "duplicate":
    case "coalesced":
      if (status === 202) {
        const kind =
          outcome === "accepted"
            ? "admitted"
            : outcome === "filtered" || outcome === "prompt_too_long"
              ? "noop"
              : outcome;
        return { kind, status };
      }
  }
  if (status === 429 || status === 408 || status === 425 || (status >= 500 && status < 600)) {
    const retryAfter = parseRetryAfter(reply.retryAfter);
    return {
      kind: "retry",
      status,
      possiblyAdmitted: status !== 429,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
  if (status >= 400 && status < 500) return { kind: "rejected", status };
  return unconfirmed;
}

export const deliver = Effect.fn("SelfHostedRelayHookDelivery.deliver")(function* (
  privateKey: string,
  delivery: RelayHookDelivery,
  signal?: AbortSignal,
) {
  const forwarding = yield* Forwarding.RelayForwarding;
  if (signal?.aborted) return unsent;
  return yield* signSelfHostedRelayHookDelivery({ ...delivery, privateKey }).pipe(
    Effect.flatMap((proof) =>
      forwarding.deliverHook(
        delivery.environmentId,
        {
          method: delivery.method,
          rawTarget: delivery.rawTarget,
          headers: { ...delivery.headers, [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: proof },
          body: delivery.body,
        },
        signal,
      ),
    ),
    Effect.map(deliveryResult),
    Effect.catchTags({
      InvalidSelfHostedRelayHookProof: () =>
        Effect.succeed({ kind: "rejected", status: 400 } as const),
      SelfHostedRelayHookSigningUnavailable: () => Effect.succeed(unsent),
      RelayInputError: () => Effect.succeed(unsent),
      RelayForwardingUnavailableError: ({ reason }) =>
        Effect.succeed(reason === "publisher-offline" ? unsent : unconfirmed),
    }),
  );
});
