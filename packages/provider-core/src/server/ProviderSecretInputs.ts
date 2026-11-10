import type {
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** The exact execution a provider's live masked prompt belongs to. */
export interface ProviderSecretInputOwner {
  readonly threadId: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
}

export type ProviderSecretInputAnswer =
  | { readonly type: "save"; readonly secret: Redacted.Redacted<string> }
  | { readonly type: "decline" };

export interface ProviderSecretInputReceiver {
  readonly owner: ProviderSecretInputOwner;
  /** False when the provider prompt already closed, so nothing reached the provider. */
  readonly deliver: (answer: ProviderSecretInputAnswer) => Effect.Effect<boolean>;
}

const key = (threadId: ThreadId, turnItemId: TurnItemId) => `${threadId}\u0000${turnItemId}`;

/**
 * Live, in-memory hand-off from a secret request card to the provider prompt that is
 * waiting for it. Values pass straight to `deliver`; nothing here stores them.
 */
export class ProviderSecretInputs extends Context.Service<
  ProviderSecretInputs,
  {
    readonly register: (receiver: ProviderSecretInputReceiver) => Effect.Effect<void>;
    /** Removes the receiver only if it is still the one registered for its card. */
    readonly unregister: (receiver: ProviderSecretInputReceiver) => Effect.Effect<void>;
    readonly lookup: (
      threadId: ThreadId,
      turnItemId: TurnItemId,
    ) => Effect.Effect<Option.Option<ProviderSecretInputReceiver>>;
    /** One answer per registration: true only for the caller that removed it. */
    readonly claim: (receiver: ProviderSecretInputReceiver) => Effect.Effect<boolean>;
  }
>()("@t3tools/provider-core/server/ProviderSecretInputs") {}

const make = Effect.sync(() => {
  const receivers = new Map<string, ProviderSecretInputReceiver>();
  const claim = Effect.fn("ProviderSecretInputs.claim")((receiver: ProviderSecretInputReceiver) =>
    Effect.sync(() => {
      const id = key(receiver.owner.threadId, receiver.owner.turnItemId);
      if (receivers.get(id) !== receiver) return false;
      receivers.delete(id);
      return true;
    }),
  );
  return ProviderSecretInputs.of({
    register: Effect.fn("ProviderSecretInputs.register")((receiver) =>
      Effect.sync(() => {
        receivers.set(key(receiver.owner.threadId, receiver.owner.turnItemId), receiver);
      }),
    ),
    unregister: Effect.fn("ProviderSecretInputs.unregister")((receiver) =>
      Effect.asVoid(claim(receiver)),
    ),
    lookup: Effect.fn("ProviderSecretInputs.lookup")((threadId, turnItemId) =>
      Effect.sync(() => Option.fromNullishOr(receivers.get(key(threadId, turnItemId)))),
    ),
    claim,
  });
});

export const layer = Layer.effect(ProviderSecretInputs, make);
