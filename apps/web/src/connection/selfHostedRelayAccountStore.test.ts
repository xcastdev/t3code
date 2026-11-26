import { expect, it } from "@effect/vitest";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayAccountStore } from "@t3tools/client-runtime/self-hosted-relay";
import { SelfHostedRelayGrantId, SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as ConnectionStorage from "./storage";

const mockIndexedDb = Effect.fnUntraced(function* (desktop = false, enableLocks = true) {
  const rows = new Map<IDBValidKey, unknown>();
  const result = <T>(event: string, result: T) => {
    const request = Object.assign(new EventTarget(), { result });
    queueMicrotask(() => request.dispatchEvent(new Event(event)));
    return request;
  };
  const open = vi.fn(() =>
    result(
      "success",
      Object.assign(new EventTarget(), {
        close() {},
        transaction(storeName: string, mode: IDBTransactionMode) {
          expect(storeName).toBe("catalog");
          const transaction = new EventTarget();
          const commit = (write: () => void) =>
            queueMicrotask(() => {
              write();
              transaction.dispatchEvent(new Event("complete"));
            });
          return Object.assign(transaction, {
            objectStore: () => ({
              get: (key: IDBValidKey) => result("success", rows.get(key)),
              put: (value: unknown, key: IDBValidKey) => {
                expect(mode).toBe("readwrite");
                commit(() => {
                  rows.set(key, value);
                });
              },
              delete: (key: IDBValidKey) =>
                commit(() => {
                  rows.delete(key);
                }),
            }),
          });
        },
      }),
    ),
  );
  const pending = new Map<string, Promise<unknown>>();
  const locks = {
    request<T>(name: string, options: LockOptions, callback: () => Promise<T>) {
      const previous = pending.get(name) ?? Promise.resolve();
      const result = previous.then(() => {
        options.signal?.throwIfAborted();
        return callback();
      });
      pending.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  };
  vi.stubGlobal("window", desktop ? { desktopBridge: {} } : {});
  vi.stubGlobal("indexedDB", { open });
  vi.stubGlobal("navigator", enableLocks ? { locks } : {});
  vi.stubGlobal("localStorage", undefined);
  yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
  return { open, rows };
});

it.effect("round trips the account across IndexedDB connections without using local storage", () =>
  Effect.gen(function* () {
    const { rows, open } = yield* mockIndexedDb(true);
    const relayId = SelfHostedRelayId.make("private-relay");
    const account = {
      version: 1,
      metadata: {
        managementOrigin: "https://management.example.test",
        relayId,
        label: "Private relay",
      },
      session: Redacted.make({
        version: 1 as const,
        relayId,
        sessionId: SelfHostedRelayGrantId.make("session"),
        credential: "private-session",
      }),
    } as const;
    const withStore = <A, E>(
      run: (store: SelfHostedRelayAccountStore["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.flatMap(SelfHostedRelayAccountStore, run).pipe(
        Effect.provide(Layer.fresh(ConnectionStorage.layer)),
      );
    yield* withStore((store) =>
      store.exclusive(
        Effect.flatMap(store.newRevision, (revision) =>
          store.write({ version: 2, revision, account, withdrawal: null }),
        ),
      ),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
    const loaded = yield* withStore((store) => store.read);
    expect(open).toHaveBeenCalledTimes(2);
    expect(loaded?.account?.metadata).toEqual(account.metadata);
    expect(loaded?.account && Redacted.value(loaded.account.session)).toEqual(
      Redacted.value(account.session),
    );
    yield* withStore((store) =>
      store.exclusive(
        Effect.flatMap(store.newRevision, (revision) =>
          store.write({ version: 2, revision, account: null, withdrawal: null }),
        ),
      ),
    );
    const cleared = yield* withStore((store) => store.read);
    expect(cleared).toMatchObject({ account: null, withdrawal: null });
    expect(cleared?.revision).not.toBe(loaded?.revision);
    expect([...rows.values()][0]).not.toContain("private-session");
  }),
);

it.effect("fails closed when the browser cannot share the account lock", () =>
  Effect.gen(function* () {
    const { open } = yield* mockIndexedDb(false, false);
    const failure = yield* Effect.flatMap(SelfHostedRelayAccountStore, (store) =>
      store.exclusive(store.read).pipe(Effect.flip),
    ).pipe(Effect.provide(Layer.fresh(ConnectionStorage.layer)));
    expect(failure).toMatchObject({
      reason: "storage-unavailable",
    });
    expect(open).not.toHaveBeenCalled();
  }),
);

it.effect("shares the browser account lock and broadcasts payload-free invalidations", () =>
  Effect.gen(function* () {
    yield* mockIndexedDb();
    const payloads: Array<unknown> = [];
    const BrowserChannel = BroadcastChannel;
    vi.stubGlobal(
      "BroadcastChannel",
      class extends BrowserChannel {
        override postMessage(message: unknown) {
          payloads.push(message);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped.
          super.postMessage(message);
        }
      },
    );
    const firstContext = yield* Layer.build(Layer.fresh(ConnectionStorage.layer));
    const secondContext = yield* Layer.build(Layer.fresh(ConnectionStorage.layer));
    const a = yield* SelfHostedRelayAccountStore.pipe(Effect.provide(firstContext));
    const b = yield* SelfHostedRelayAccountStore.pipe(Effect.provide(secondContext));
    const changed = yield* Stream.runHead(b.changes).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    const locked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* a
      .exclusive(
        Effect.gen(function* () {
          yield* Deferred.succeed(locked, undefined);
          yield* Deferred.await(release);
          const revision = yield* a.newRevision;
          yield* a.write({ version: 2, revision, account: null, withdrawal: null });
          return revision;
        }),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(locked);
    const waiter = yield* b.exclusive(b.read).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    const revision = yield* Fiber.join(holder);
    expect(yield* Fiber.join(waiter)).toMatchObject({ revision });
    expect((yield* Fiber.join(changed))._tag).toBe("Some");
    expect(payloads).toEqual([null]);
  }),
);

it.effect("withdraws the latest stored directory routes across browser catalog instances", () =>
  Effect.gen(function* () {
    yield* mockIndexedDb();
    const first = yield* Layer.build(Layer.fresh(ConnectionStorage.layer));
    const second = yield* Layer.build(Layer.fresh(ConnectionStorage.layer));
    const a = yield* Persistence.ConnectionRegistrationStore.pipe(Effect.provide(first));
    const b = yield* Persistence.ConnectionRegistrationStore.pipe(Effect.provide(second));
    const targets = yield* Persistence.ConnectionTargetStore.pipe(Effect.provide(first));
    const environmentId = EnvironmentId.make("existing");
    const connectionId = "learned:source";
    const source = JSON.stringify(["private-relay", "self-hosted-relay-account"]);
    const target = new BearerConnectionTarget({ environmentId, connectionId, label: "Learned" });
    const profile = new BearerConnectionProfile({
      environmentId,
      connectionId,
      label: target.label,
      httpBaseUrl: "https://route.example.test",
      wsBaseUrl: "wss://route.example.test",
      learned: true,
      directorySource: source,
    });
    expect(yield* targets.list).toEqual([]);
    yield* b.setLearnedRoutes(environmentId, [target], {
      profiles: [profile],
      removedConnectionIds: new Set(),
    });
    expect(yield* a.listDirectoryRoutes(source)).toEqual([{ environmentId, connectionId }]);
    yield* a.setLearnedRoutes(environmentId, [], {
      profiles: [],
      removedConnectionIds: new Set([connectionId]),
    });
    yield* b.setEnabled(environmentId, false);
    const reopened = yield* Layer.build(Layer.fresh(ConnectionStorage.layer));
    const reopenedTargets = yield* Persistence.ConnectionTargetStore.pipe(Effect.provide(reopened));
    const reopenedRegistrations = yield* Persistence.ConnectionRegistrationStore.pipe(
      Effect.provide(reopened),
    );
    expect(yield* reopenedTargets.list).toEqual([]);
    expect(yield* reopenedRegistrations.listDirectoryRoutes(source)).toEqual([]);
  }),
);
