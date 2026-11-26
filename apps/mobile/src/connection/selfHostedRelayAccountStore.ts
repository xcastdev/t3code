import { makeAccountStore } from "@t3tools/client-runtime/self-hosted-relay";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { MobileSecureStorage } from "../persistence/mobile-secure-storage";

const accountKey = "t3code.self-hosted-relay-account.v1";
const accountLock = Semaphore.makeUnsafe(1);
const invalidations = Effect.runSync(PubSub.sliding<void>(1));

export const make = Effect.fn("mobile.selfHostedRelayAccountStore.make")(function* () {
  const storage = yield* MobileSecureStorage;
  return makeAccountStore({
    read: storage.getItem(accountKey),
    write: (raw) => storage.setItem(accountKey, raw),
    exclusive: (effect) => accountLock.withPermit(effect),
    changes: Stream.fromPubSub(invalidations),
    invalidate: () => PubSub.publishUnsafe(invalidations, undefined),
    newRevision: Effect.promise(async () => (await import("../lib/uuid")).uuidv4()),
  });
});
