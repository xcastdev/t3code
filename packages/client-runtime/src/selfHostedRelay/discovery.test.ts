import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayGrantId, SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

vi.mock("effect/Deferred", async (importOriginal) => {
  const actual = await importOriginal<typeof Deferred>();
  return { ...actual, done: vi.fn(actual.done) };
});

import { ConnectionPersistenceError } from "../platform/persistence.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { makeAccountStore } from "./account.ts";
import { makeDirectory, MAX_DIRECTORY_BYTES, SelfHostedRelayManagementFetch } from "./discovery.ts";

const relayId = SelfHostedRelayId.make("relay-one");
const account = {
  managementOrigin: "https://management.example.test/",
  label: "Private relay",
  session: {
    version: 1,
    relayId,
    sessionId: SelfHostedRelayGrantId.make("session-one"),
    credential: "private-session-token",
  },
} as const;

const row = {
  version: 1,
  relayId,
  environmentId: EnvironmentId.make("environment-without-pairing"),
  name: "Directory name",
  addressHints: [{ kind: "relay", httpBaseUrl: "https://forwarding.example.test" }],
} as const;
const snapshot = { version: 1, environments: [row] } as const;
const json = (value: unknown, status = 200) => Response.json(value, { status });

function fixture(
  fetch: typeof globalThis.fetch,
  beforeApply: (snapshot: {
    readonly environments: ReadonlyArray<unknown>;
  }) => Effect.Effect<void, ConnectionPersistenceError> = () => Effect.void,
  notify = false,
) {
  let raw: unknown;
  let offline = false;
  let available = true;
  let writesBeforeFailure = Infinity;
  const inaccessible = Effect.fail("private storage error");
  return Effect.gen(function* () {
    const changes = yield* Queue.unbounded<"online" | "offline">();
    const applied = yield* Queue.unbounded<{
      source: { relayId: string; key: string };
      snapshot: unknown;
    }>();
    const fence = yield* Semaphore.make(1);
    const invalidations = yield* PubSub.sliding<void>(1);
    const makeStore = () =>
      makeAccountStore({
        exclusive: (effect) => fence.withPermit(effect),
        ...(notify
          ? {
              changes: Stream.fromPubSub(invalidations),
              invalidate: () => PubSub.publishUnsafe(invalidations, undefined),
            }
          : {}),
        read: Effect.suspend(() => (available ? Effect.succeed(raw) : inaccessible)),
        write: (value) =>
          Effect.suspend(() => {
            if (writesBeforeFailure-- <= 0) return inaccessible;
            raw = value;
            return Effect.void;
          }),
      });
    const store = makeStore();
    const open = Effect.suspend(() =>
      makeDirectory({
        store: makeStore(),
        connectivity: {
          status: Effect.sync(() => (offline ? "offline" : "online")),
          changes: Stream.fromQueue(changes),
        },
        apply: (source, snapshot) =>
          beforeApply(snapshot).pipe(
            Effect.andThen(Queue.offer(applied, { source, snapshot })),
            Effect.asVoid,
          ),
      }),
    );
    const openWithFetch = open.pipe(Effect.provideService(SelfHostedRelayManagementFetch, fetch));
    return {
      open: openWithFetch,
      openWith: (override: typeof fetch) =>
        open.pipe(Effect.provideService(SelfHostedRelayManagementFetch, override)),
      store,
      applied,
      failWritesAfter: (count: number) => {
        writesBeforeFailure = count;
      },
      setAvailable: (value: boolean) => {
        available = value;
      },
      setRaw: (value: unknown) => {
        raw = value;
      },
      network: (isOffline: boolean) =>
        Effect.sync(() => {
          offline = isOffline;
        }).pipe(Effect.andThen(Queue.offer(changes, isOffline ? "offline" : "online"))),
    };
  });
}

it.effect(
  "starts idle, restarts from private storage, and only sends the session to the management origin",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
      const test = yield* fixture(async (url, options) => {
        calls.push({ url: String(url), options });
        return json(snapshot);
      });
      let source: unknown;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* test.open;
          yield* directory.start;
          expect(yield* directory.refresh).toBe("unconfigured");
          yield* TestClock.adjust("60 seconds");
          expect(calls).toHaveLength(0);
          yield* directory.configure(account);
          expect((yield* directory.account)?.managementOrigin).toBe(
            "https://management.example.test",
          );
          expect(yield* directory.account).toEqual({
            managementOrigin: "https://management.example.test",
            relayId,
            label: "Private relay",
          });
          source = (yield* Queue.take(test.applied)).source;
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* test.open;
          yield* directory.start;
          expect(yield* Queue.take(test.applied)).toEqual({ source, snapshot });
        }),
      );
      expect(calls).toHaveLength(2);
      for (const { url, options } of calls) {
        expect(url).toBe("https://management.example.test/api/self-hosted-relay/v1/directory");
        expect(options).toMatchObject({
          method: "GET",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        const headers = new Headers(options?.headers);
        expect(headers.get("authorization")).toBe("Bearer private-session-token");
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("traceparent")).toBe(false);
      }
    }),
);

it.effect("rejects corrupt storage and invalid origins without making a request", () =>
  Effect.gen(function* () {
    const test = yield* fixture(async () => {
      throw new Error("unexpected fetch");
    });
    test.setRaw(JSON.stringify({ secret: "corrupt-session" }));
    const directory = yield* test.open;
    yield* directory.start;
    expect(yield* directory.account).toBeNull();
    expect(yield* directory.refresh).toBe("unconfigured");
    for (const managementOrigin of [
      "http://management.example.test",
      "https://user:password@management.example.test",
      "https://management.example.test/?credential=private",
      "https://management.example.test/forward",
    ]) {
      expect(
        yield* directory.configure({ ...account, managementOrigin }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-account" });
    }
    yield* directory.clear;
    expect(yield* Queue.size(test.applied)).toBe(0);
  }),
);

it.effect("preserves the cached snapshot for offline, refused, partial and invalid responses", () =>
  Effect.gen(function* () {
    const responses: Array<() => Response> = [];
    const test = yield* fixture(async () => {
      const reply = responses.shift();
      if (reply === undefined) throw new Error("Unexpected directory request");
      return reply();
    });
    yield* test.network(true);
    const directory = yield* test.open;
    yield* directory.start;
    yield* directory.configure(account);
    expect(yield* directory.refresh).toBe("offline");
    responses.push(() => json(snapshot));
    yield* test.network(false);
    yield* Queue.take(test.applied);
    const oversized = () =>
      new Response(new Uint8Array(MAX_DIRECTORY_BYTES + 1), {
        headers: { "content-type": "application/json" },
      });
    for (const [reply, reason] of [
      [() => Response.redirect("https://forwarding.example.test"), "directory-unavailable"],
      [
        () => Object.defineProperty(json(snapshot), "redirected", { value: true }),
        "directory-unavailable",
      ],
      [() => json({}, 401), "unauthorized"],
      [() => json({}, 403), "forbidden"],
      [() => json(snapshot, 206), "directory-unavailable"],
      [() => json({ ...snapshot, extra: true }), "invalid-directory"],
      [
        () => json({ ...snapshot, environments: [{ ...row, relayId: "another-relay" }] }),
        "invalid-directory",
      ],
      [() => json({ ...snapshot, environments: [row, row] }), "invalid-directory"],
      [oversized, "invalid-directory"],
    ] as const) {
      responses.push(reply);
      expect(yield* directory.refresh.pipe(Effect.flip)).toMatchObject({ reason });
    }
    expect(yield* Queue.size(test.applied)).toBe(0);
    responses.push(() => json(snapshot));
    yield* TestClock.adjust("30 seconds");
    expect((yield* Queue.take(test.applied)).snapshot).toEqual(snapshot);
  }),
);

it.effect(
  "coalesces refreshes, discards late responses on replacement and removal, and aborts on close",
  () =>
    Effect.gen(function* () {
      type Request = {
        release: (response: Response) => void;
        signal: AbortSignal | null | undefined;
      };
      const requests = yield* Queue.unbounded<Request>();
      const test = yield* fixture((_url, options) => {
        const reply = Promise.withResolvers<Response>();
        Queue.offerUnsafe(requests, { release: reply.resolve, signal: options?.signal });
        return reply.promise;
      });
      const closeRequest = yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* test.open;
          yield* directory.start;
          yield* directory.configure(account);
          const old = yield* Queue.take(requests);
          const awaiting = yield* directory.refresh.pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          const coalesced = yield* directory.refresh.pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          expect(yield* Queue.size(requests)).toBe(0);
          yield* directory.configure({
            ...account,
            managementOrigin: "https://replacement.example.test",
          });
          expect(yield* Fiber.join(awaiting)).toBe("superseded");
          expect(yield* Fiber.join(coalesced)).toBe("superseded");
          expect(old.signal?.aborted).toBe(true);
          old.release(json(snapshot));
          expect((yield* Queue.take(test.applied)).snapshot).toEqual({
            version: 1,
            environments: [],
          });
          const replacement = yield* Queue.take(requests);
          yield* directory.clear;
          expect(replacement.signal?.aborted).toBe(true);
          replacement.release(json(snapshot));
          expect((yield* Queue.take(test.applied)).snapshot).toEqual({
            version: 1,
            environments: [],
          });
          expect(yield* directory.refresh).toBe("unconfigured");
          yield* directory.configure(account);
          return yield* Queue.take(requests);
        }),
      );
      expect(closeRequest.signal?.aborted).toBe(true);
      closeRequest.release(json(snapshot));
      yield* TestClock.adjust("60 seconds");
      expect(yield* Queue.size(requests)).toBe(0);
      expect(yield* Queue.size(test.applied)).toBe(0);
    }),
);

it.effect("fails closed on unavailable storage and resumes from the saved record on restart", () =>
  Effect.gen(function* () {
    let calls = 0;
    const test = yield* fixture(async () => {
      calls++;
      return json(snapshot);
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* test.open;
        yield* directory.start;
        yield* directory.configure(account);
        yield* directory.refresh;
      }),
    );
    test.setAvailable(false);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* test.open;
        yield* directory.start;
        expect(yield* directory.refresh).toBe("unconfigured");
        const failure = yield* directory.configure(account).pipe(Effect.flip);
        expect(failure.reason).toBe("storage-unavailable");
        expect(JSON.stringify(failure)).not.toContain("private storage error");
        yield* TestClock.adjust("60 seconds");
      }),
    );
    expect(calls).toBe(1);
    test.setAvailable(true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* test.open;
        yield* directory.start;
        yield* directory.refresh;
      }),
    );
    expect(calls).toBe(2);
  }),
);

it.effect("waits for a committed apply before withdrawing and retries a failed withdrawal", () =>
  Effect.gen(function* () {
    const applying = yield* Deferred.make<void>();
    const releaseApply = yield* Deferred.make<void>();
    let refuseWithdrawal = true;
    const test = yield* fixture(
      async () => json(snapshot),
      ({ environments }) =>
        environments.length > 0
          ? Deferred.succeed(applying, undefined).pipe(Effect.andThen(Deferred.await(releaseApply)))
          : Effect.suspend(() =>
              refuseWithdrawal
                ? new ConnectionPersistenceError({
                    operation: "set-connection-routes",
                    message: "private cache error",
                  })
                : Effect.void,
            ),
    );
    const directory = yield* test.open;
    yield* directory.start;
    yield* directory.configure(account);
    yield* Deferred.await(applying);
    const second = yield* test.open;
    const clearing = yield* second.clear.pipe(
      Effect.flip,
      Effect.forkScoped({ startImmediately: true }),
    );
    expect(yield* directory.account).toMatchObject({ relayId });
    yield* Deferred.succeed(releaseApply, undefined);
    const failure = yield* Fiber.join(clearing);
    expect(failure.reason).toBe("cache-unavailable");
    expect(JSON.stringify(failure)).not.toContain("private cache error");
    expect((yield* Queue.take(test.applied)).snapshot).toEqual(snapshot);
    expect(yield* directory.refresh).toBe("superseded");
    expect(yield* directory.refresh).toBe("unconfigured");
    expect((yield* test.store.read)?.withdrawal).toBe(relayId);
    refuseWithdrawal = false;
    yield* directory.clear;
    expect((yield* Queue.take(test.applied)).snapshot).toEqual({ version: 1, environments: [] });
    expect(yield* test.store.read).toMatchObject({ account: null, withdrawal: null });
  }),
);

it.effect(
  "uses the management-specific fetch override without falling back to destination transport",
  () =>
    Effect.gen(function* () {
      let fallbackCalls = 0;
      const test = yield* fixture(async () => json(snapshot));
      const directory = yield* test
        .openWith(async (_url, options) => {
          expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
          throw new Error("Bearer private-session-token for https://management.example.test");
        })
        .pipe(
          Effect.provide(
            layerRemoteHttpClient(async () => {
              fallbackCalls++;
              return json(snapshot);
            }),
          ),
        );
      yield* directory.start;
      yield* directory.configure(account);
      const error = yield* directory.refresh.pipe(Effect.flip);
      expect(error.reason).toBe("directory-unavailable");
      expect(error.message).not.toContain("private-session-token");
      expect(JSON.stringify(error)).not.toContain("management.example.test");
      expect(fallbackCalls).toBe(0);
      expect(yield* Queue.size(test.applied)).toBe(0);
    }),
);

const replacement = {
  ...account,
  managementOrigin: "https://replacement.example.test",
  label: "Replacement",
  session: { ...account.session, credential: "replacement-session-token" },
};
const emptySnapshot = { version: 1, environments: [] } as const;

it.effect.each(["clear", "replace"] as const)(
  "retires a stale runtime after another runtime performs %s",
  (action) =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<{
        credential: string | null;
        reply: (response: Response) => void;
      }>();
      const test = yield* fixture((_url, options) => {
        const response = Promise.withResolvers<Response>();
        Queue.offerUnsafe(requests, {
          credential: new Headers(options?.headers).get("authorization"),
          reply: response.resolve,
        });
        return response.promise;
      });
      const first = yield* test.open;
      const second = yield* test.open;
      yield* first.start;
      yield* second.start;
      yield* first.configure(account);
      const late = yield* Queue.take(requests);
      const inFlight = yield* first.refresh.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* action === "clear" ? second.clear : second.configure(replacement);
      expect((yield* Queue.take(test.applied)).snapshot).toEqual(emptySnapshot);
      if (action === "replace") {
        const next = yield* Queue.take(requests);
        expect(next.credential).toBe("Bearer replacement-session-token");
        next.reply(json(emptySnapshot));
        expect(yield* second.refresh).toBe("refreshed");
        yield* Queue.take(test.applied);
      }
      late.reply(json(snapshot));
      expect(yield* Fiber.join(inFlight)).toBe("superseded");
      expect(yield* first.refresh).toBe("unconfigured");
      yield* TestClock.adjust("30 seconds");
      expect(
        (yield* Queue.takeBetween(requests, 0, Infinity)).every(
          (request) => request.credential !== "Bearer private-session-token",
        ),
      ).toBe(true);
      expect(yield* Queue.size(test.applied)).toBe(0);
    }),
);

it.effect.each(["clear", "replace"] as const)(
  "uses the last validated source for %s after disk corruption and a failed withdrawal",
  (action) =>
    Effect.gen(function* () {
      let failWithdrawal = true;
      const test = yield* fixture(
        async () => json(snapshot),
        ({ environments }) =>
          environments.length === 0 && failWithdrawal
            ? Effect.fail(
                new ConnectionPersistenceError({
                  operation: "set-connection-routes",
                  message: "withdrawal failed",
                }),
              )
            : Effect.void,
      );
      yield* test.network(true);
      const directory = yield* test.open;
      yield* directory.configure(account);
      test.setRaw("{broken");
      const change = action === "clear" ? directory.clear : directory.configure(replacement);
      expect(yield* change.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "cache-unavailable" },
      });
      failWithdrawal = false;
      yield* change;
      expect(yield* Queue.take(test.applied)).toEqual({
        source: { relayId, key: "self-hosted-relay-account" },
        snapshot: emptySnapshot,
      });
    }),
);

it.effect.each(["clear", "replace"] as const)(
  "recovers a failed %s commit on an offline restart",
  (action) =>
    Effect.gen(function* () {
      const test = yield* fixture(async () => json(snapshot));
      yield* test.network(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* test.open;
          yield* directory.start;
          yield* directory.configure(account);
          const change = action === "clear" ? directory.clear : directory.configure(replacement);
          test.failWritesAfter(0);
          expect(yield* change.pipe(Effect.flip)).toMatchObject({ reason: "storage-unavailable" });
          expect(yield* Queue.size(test.applied)).toBe(0);
          test.failWritesAfter(1);
          expect(yield* change.pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "storage-unavailable" },
          });
          expect((yield* Queue.take(test.applied)).snapshot).toEqual(emptySnapshot);
        }),
      );
      test.failWritesAfter(Infinity);
      const restarted = yield* test.open;
      yield* restarted.start;
      expect((yield* Queue.take(test.applied)).snapshot).toEqual(emptySnapshot);
      expect((yield* restarted.account)?.label ?? null).toBe(
        action === "clear" ? null : replacement.label,
      );
    }),
);

it.effect("recovers a transition that stopped before withdrawal completed", () =>
  Effect.gen(function* () {
    let failWithdrawal = true;
    const test = yield* fixture(
      async () => json(snapshot),
      ({ environments }) =>
        environments.length === 0 && failWithdrawal
          ? Effect.fail(
              new ConnectionPersistenceError({
                operation: "set-connection-routes",
                message: "stopped during withdrawal",
              }),
            )
          : Effect.void,
    );
    yield* test.network(true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* test.open;
        yield* directory.start;
        yield* directory.configure(account);
        expect(yield* directory.configure(replacement).pipe(Effect.flip)).toMatchObject({
          reason: "cache-unavailable",
        });
      }),
    );
    failWithdrawal = false;
    const restarted = yield* test.open;
    yield* restarted.start;
    expect((yield* restarted.account)?.label).toBe(replacement.label);
    expect((yield* Queue.take(test.applied)).snapshot).toEqual(emptySnapshot);
  }),
);

it.effect("checks the stored revision before sending the next request from an idle runtime", () =>
  Effect.gen(function* () {
    const credentials: Array<string | null> = [];
    const test = yield* fixture(async (_url, options) => {
      credentials.push(new Headers(options?.headers).get("authorization"));
      return json(snapshot);
    });
    const first = yield* test.open;
    const second = yield* test.open;
    yield* first.configure(account);
    expect(yield* first.refresh).toBe("refreshed");
    expect(yield* Queue.take(test.applied)).toMatchObject({ snapshot });
    yield* second.clear;
    expect(yield* Queue.take(test.applied)).toMatchObject({ snapshot: emptySnapshot });
    expect(yield* first.refresh).toBe("superseded");
    expect(credentials).toEqual(["Bearer private-session-token"]);
  }),
);

it.effect("aborts an in-flight request when another runtime invalidates its revision", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    const test = yield* fixture(
      (_url, options) => {
        options?.signal?.addEventListener(
          "abort",
          () => Deferred.doneUnsafe(aborted, Effect.void),
          { once: true },
        );
        Deferred.doneUnsafe(dispatched, Effect.void);
        return Promise.withResolvers<Response>().promise;
      },
      () => Effect.void,
      true,
    );
    const first = yield* test.open;
    const second = yield* test.open;
    yield* first.start;
    yield* first.configure(account);
    yield* Deferred.await(dispatched);
    const inFlight = yield* first.refresh.pipe(Effect.forkScoped({ startImmediately: true }));
    yield* second.clear;
    yield* Deferred.await(aborted);
    expect(yield* Fiber.join(inFlight)).toBe("superseded");
    expect(yield* first.account).toBeNull();
    expect(yield* Queue.take(test.applied)).toMatchObject({ snapshot: emptySnapshot });
    expect(yield* Queue.size(test.applied)).toBe(0);
  }),
);

it.effect("settles an explicit refresh when the worker is interrupted at completion", () =>
  Effect.gen(function* () {
    const applying = yield* Deferred.make<void>();
    const releaseApply = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<{
      worker: Fiber.Fiber<unknown, unknown>;
      isSettled: Effect.Effect<boolean>;
    }>();
    using _complete = vi.spyOn(Deferred, "done").mockImplementation((request, result) => {
      const done = Deferred.completeWith(request, result);
      if (!Exit.isSuccess(result) || result.value !== "refreshed") return done;
      return Effect.withFiber((worker) =>
        Effect.sync(() => {
          Deferred.doneUnsafe(
            interrupted,
            Effect.succeed({
              worker,
              isSettled: Deferred.isDone(request),
            }),
          );
          worker.interruptUnsafe();
        }).pipe(Effect.andThen(done)),
      );
    });

    const test = yield* fixture(
      async () => json(snapshot),
      (value) =>
        value.environments.length === 0
          ? Effect.void
          : Deferred.succeed(applying, undefined).pipe(
              Effect.andThen(Deferred.await(releaseApply)),
            ),
    );
    const directory = yield* test.open;
    yield* directory.configure(account);
    yield* Deferred.await(applying);
    const refresh = yield* directory.refresh.pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(releaseApply, undefined);
    const { worker, isSettled } = yield* Deferred.await(interrupted);
    expect(Exit.hasInterrupts(yield* Fiber.await(worker))).toBe(true);
    yield* directory.clear;
    expect(yield* isSettled).toBe(true);
    expect(yield* Fiber.join(refresh)).toBe("refreshed");
  }),
);
