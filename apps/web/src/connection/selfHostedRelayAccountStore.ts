import type { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import {
  makeAccountStore,
  SelfHostedRelayAccountError,
} from "@t3tools/client-runtime/self-hosted-relay";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const accountKey = "self-hosted-relay-account.v1";
const accountLock = "t3code:relay-account";
const invalidationChannel = "t3code:relay-account-changed";

export const withWebLock =
  <Failure>(locks: LockManager, name: string, onFailure: () => Failure) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Failure, R> =>
    Effect.flatMap(Effect.context<R>(), (context) =>
      Effect.callback<A, E | Failure>((resume, signal) => {
        const fail = () => resume(Effect.fail(onFailure()));
        try {
          void locks
            .request(name, { signal }, () => Effect.runPromiseExitWith(context)(effect, { signal }))
            .then(resume, fail);
        } catch {
          fail();
        }
      }),
    );

export const make = Effect.fn("web.selfHostedRelayAccountStore.make")(function* (indexedDb: {
  readonly read: (key: string) => Effect.Effect<unknown, ConnectionTransientError>;
  readonly write: (key: string, value: string) => Effect.Effect<void, ConnectionTransientError>;
}) {
  const locks = globalThis.navigator?.locks;
  const unavailable = () => new SelfHostedRelayAccountError({ reason: "storage-unavailable" });
  const channel = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new BroadcastChannel(invalidationChannel),
      catch: unavailable,
    }).pipe(Effect.orElseSucceed(() => null)),
    (channel) => Effect.sync(() => channel?.close()),
  );
  return makeAccountStore({
    read: indexedDb.read(accountKey),
    write: (raw) => indexedDb.write(accountKey, raw),
    // A local semaphore cannot fence account and catalog work in other tabs.
    exclusive:
      locks && channel
        ? withWebLock(locks, accountLock, unavailable)
        : () => Effect.fail(unavailable()),
    changes: channel
      ? Stream.fromEventListener(channel, "message").pipe(Stream.as(undefined))
      : Stream.empty,
    invalidate: () => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped.
      channel?.postMessage(null);
    },
  });
});
