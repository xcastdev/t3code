// @effect-diagnostics nodeBuiltinImport:off -- Isolate the production SQLite writer in a disposable home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Ingress from "./RelayHookIngress.ts";
import * as Inbox from "./RelayHookStore.ts";
import * as Store from "./RelayStore.ts";

const makeHome = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-hooks-"))),
  (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
);

function createPolicyController(): AbortController {
  return new AbortController();
}

// The fixture models operator revocation across several shorter authorization scopes.
const makePolicyController = Effect.acquireRelease(
  Effect.sync(createPolicyController),
  (controller) => Effect.sync(() => controller.abort()),
);

const receiptWindowMs = 7 * 24 * 60 * 60 * 1_000;

const request = {
  environmentId: EnvironmentId.make("test-environment"),
  hookId: "hook:id",
  method: "PATCH",
  rawTarget: "/api/relay-hooks/hook%3aid/token%2b?k=+&k=%20&lower=%2f",
  headers: { "x-signature": "sha256=abc", "content-type": "application/octet-stream" },
  body: Uint8Array.of(0, 255, 13, 10, 128),
} as const;

const seed = Effect.gen(function* () {
  const { sql } = yield* Store.RelayStore;
  yield* sql`UPDATE relay_identity SET generation = 1 WHERE singleton = 1`;
  yield* sql`INSERT INTO relay_environments (environment_id, record_json)
    VALUES (${request.environmentId}, '{}')`;
  yield* sql`INSERT INTO relay_hook_policies
    (environment_id, hook_id, generation, revision, enabled, hold_enabled)
    VALUES (${request.environmentId}, ${request.hookId}, 1, 'v1', 1, 1),
           (${request.environmentId}, 'other', 1, 'v1', 1, 1)`;
});

type Options = Parameters<typeof Ingress.layer>[0];
const runtime = (homeDirectory: string, options: Partial<Options> = {}) =>
  Ingress.layer({
    resolvePolicy: () => Effect.succeed({ holdEnabled: true, revision: "v1" }),
    deliver: () => Effect.succeed({ kind: "retry", status: 503, possiblyAdmitted: true }),
    ...options,
  }).pipe(Layer.provideMerge(Inbox.layer), Layer.provideMerge(Store.layer(homeDirectory)));

it.effect(
  "retries a lost reply after reopening the writer with the exact original signed inputs",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const attempts: Ingress.RelayHookDelivery[] = [];
      const destinationReceipts = new Map<string, Ingress.RelayHookDeliveryResult>();
      const first = yield* Effect.gen(function* () {
        yield* seed;
        const ingress = yield* Ingress.RelayHookIngress;
        const receivedAt = DateTime.formatIso(yield* DateTime.now);
        const held = yield* ingress.receive(request);
        assert.equal(held.kind, "held");
        if (held.kind !== "held") return assert.fail();
        const { sql } = yield* Store.RelayStore;
        assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
        assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 2 }]);
        assert.deepEqual(yield* sql`PRAGMA fullfsync`, [{ fullfsync: 1 }]);
        assert.deepEqual(yield* sql`PRAGMA checkpoint_fullfsync`, [{ checkpoint_fullfsync: 1 }]);
        return { receivedAt, id: held.deliveryId };
      }).pipe(
        Effect.provide(
          runtime(home, {
            deliver: (delivery) =>
              Effect.sync(() => {
                attempts.push(delivery);
                destinationReceipts.set(delivery.deliveryId, { kind: "admitted", status: 202 });
                return { kind: "retry", status: 504, possiblyAdmitted: true };
              }),
          }),
        ),
      );

      yield* TestClock.adjust("10 seconds");
      yield* Effect.gen(function* () {
        const ingress = yield* Ingress.RelayHookIngress;
        const store = yield* Inbox.RelayHookStore;
        assert.deepEqual(yield* store.getOutcome(first.id), { kind: "held", status: 202 });
        assert.equal(yield* ingress.dispatchDue(), Date.parse(first.receivedAt) + receiptWindowMs);
        assert.deepEqual(yield* store.getOutcome(first.id), { kind: "admitted", status: 202 });
        assert.equal(yield* ingress.dispatchDue(), Date.parse(first.receivedAt) + receiptWindowMs);
        const { sql, relayId } = yield* Store.RelayStore;
        assert.deepEqual(attempts, [
          { ...request, relayId, deliveryId: first.id, receivedAt: first.receivedAt },
          { ...request, relayId, deliveryId: first.id, receivedAt: first.receivedAt },
        ]);
        assert.deepEqual(yield* sql`SELECT body, raw_target, headers FROM relay_hook_deliveries`, [
          { body: null, raw_target: null, headers: null },
        ]);
      }).pipe(
        Effect.provide(
          runtime(home, {
            deliver: (delivery) =>
              Effect.sync(() => {
                attempts.push(delivery);
                return (
                  destinationReceipts.get(delivery.deliveryId) ?? { kind: "rejected", status: 409 }
                );
              }),
          }),
        ),
      );
    }),
);

it.effect(
  "keeps destination outcomes distinct at the same HTTP status and gives fresh requests new IDs",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const outcomes = ["noop", "duplicate", "coalesced", "admitted"] as const;
      let attempts = 0;
      yield* Effect.gen(function* () {
        yield* seed;
        const ingress = yield* Ingress.RelayHookIngress;
        const store = yield* Inbox.RelayHookStore;
        const ids = new Set<string>();
        for (const kind of outcomes) {
          const result = yield* ingress.receive(request);
          assert.equal(result.kind, kind);
          assert.equal(result.status, 202);
          assert.property(result, "deliveryId");
          if (!("deliveryId" in result)) return assert.fail();
          ids.add(result.deliveryId);
          assert.deepEqual(yield* store.getOutcome(result.deliveryId), { kind, status: 202 });
        }
        assert.equal(ids.size, outcomes.length);
        assert.equal(yield* ingress.dispatchDue(), receiptWindowMs);
      }).pipe(
        Effect.provide(
          runtime(home, {
            deliver: () => Effect.sync(() => ({ kind: outcomes[attempts++]!, status: 202 })),
          }),
        ),
      );
    }),
);

it.effect("won't hold when disabled or forward interactive or unexposed requests", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    let enabled = false;
    let sends = 0;
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      assert.deepEqual(yield* ingress.receive({ ...request, rawTarget: "/api/sessions" }), {
        kind: "invalid",
        status: 400,
      });
      assert.deepEqual(yield* ingress.receive({ ...request, method: "HEAD" }), {
        kind: "invalid",
        status: 405,
      });
      assert.deepEqual(yield* ingress.receive(request), { kind: "disabled", status: 404 });
      assert.deepEqual(
        yield* ingress.receive({
          ...request,
          environmentId: EnvironmentId.make("not-enrolled"),
        }),
        { kind: "disabled", status: 404 },
      );
      enabled = true;
      assert.equal((yield* ingress.receive(request)).kind, "retry");
      assert.isNull(yield* ingress.dispatchDue());
      assert.equal(sends, 1);
      const { sql } = yield* Store.RelayStore;
      assert.deepEqual(yield* sql`SELECT count(*) AS total FROM relay_hook_deliveries`, [
        { total: 0 },
      ]);
    }).pipe(
      Effect.provide(
        runtime(home, {
          resolvePolicy: ({ environmentId }) =>
            Effect.sync(() =>
              enabled || environmentId !== request.environmentId
                ? { holdEnabled: false, revision: "v1" }
                : null,
            ),
          deliver: () =>
            Effect.sync(() => {
              sends += 1;
              return { kind: "retry", status: 503, possiblyAdmitted: true };
            }),
        }),
      ),
    );
  }),
);

it.effect("honors a newer Retry-After after retry and makes a rotated task token terminal", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    let sends = 0;
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const store = yield* Inbox.RelayHookStore;
      const started = yield* Clock.currentTimeMillis;
      const held = yield* ingress.receive(request);
      if (held.kind !== "held") return assert.fail();
      assert.equal(yield* ingress.dispatchDue(), started + 40_000);
      yield* TestClock.adjust("40 seconds");
      assert.equal(yield* ingress.dispatchDue(), started + 60_000);
      assert.equal(sends, 2);
      yield* TestClock.adjust("20 seconds");
      assert.equal(yield* ingress.dispatchDue(), started + receiptWindowMs);
      assert.deepEqual(yield* store.getOutcome(held.deliveryId), { kind: "rejected", status: 401 });
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* ingress.dispatchDue(), started + receiptWindowMs);
      assert.equal(sends, 3);
    }).pipe(
      Effect.provide(
        runtime(home, {
          deliver: () =>
            Effect.sync(() => {
              sends += 1;
              if (sends === 1)
                return { kind: "retry", status: 429, possiblyAdmitted: false, retryAfter: "40" };
              if (sends === 2)
                return {
                  kind: "retry",
                  status: 429,
                  possiblyAdmitted: false,
                  retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT",
                };
              return { kind: "rejected", status: 401 };
            }),
        }),
      ),
    );
  }),
);

it.effect("expires instead of forwarding when Retry-After extends past the hold window", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    let sends = 0;
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const store = yield* Inbox.RelayHookStore;
      const started = yield* Clock.currentTimeMillis;
      const held = yield* ingress.receive(request);
      if (held.kind !== "held") return assert.fail();
      assert.equal(yield* ingress.dispatchDue(), started + 60_000);
      yield* TestClock.adjust("24 hours");
      assert.equal(yield* ingress.dispatchDue(), started + receiptWindowMs);
      assert.deepEqual(yield* store.getOutcome(held.deliveryId), { kind: "rejected", status: 410 });
      assert.equal(sends, 1);
      yield* TestClock.adjust("6 days");
      assert.isNull(yield* ingress.dispatchDue());
      assert.isNull(yield* store.getOutcome(held.deliveryId));
    }).pipe(
      Effect.provide(
        runtime(home, {
          deliver: () =>
            Effect.sync(() => {
              sends += 1;
              return { kind: "retry", status: 429, possiblyAdmitted: false, retryAfter: "100000" };
            }),
        }),
      ),
    );
  }),
);

it.effect(
  "does not revive held requests after enrollment and policy are revoked and recreated",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      let revision = "v1";
      let sends = 0;
      yield* Effect.gen(function* () {
        yield* seed;
        const ingress = yield* Ingress.RelayHookIngress;
        const store = yield* Inbox.RelayHookStore;
        const first = yield* ingress.receive(request);
        if (first.kind !== "held") return assert.fail();
        const { sql } = yield* Store.RelayStore;
        yield* sql`DELETE FROM relay_environments WHERE environment_id = ${request.environmentId}`;
        revision = "v2";
        yield* seed;
        yield* sql`UPDATE relay_hook_policies SET revision = ${revision}`;
        const second = yield* ingress.receive(request);
        if (second.kind !== "held") return assert.fail();
        revision = "v3";
        yield* sql`UPDATE relay_hook_policies SET revision = ${revision}`;
        yield* TestClock.adjust("10 seconds");
        assert.equal(yield* ingress.dispatchDue(), receiptWindowMs);
        assert.deepEqual(yield* store.getOutcome(first.deliveryId), {
          kind: "rejected",
          status: 404,
        });
        assert.deepEqual(yield* store.getOutcome(second.deliveryId), {
          kind: "rejected",
          status: 404,
        });
        assert.equal(sends, 2);
      }).pipe(
        Effect.provide(
          runtime(home, {
            resolvePolicy: () => Effect.sync(() => ({ holdEnabled: true, revision })),
            deliver: () =>
              Effect.sync(() => {
                sends += 1;
                return { kind: "retry", status: 429, possiblyAdmitted: false };
              }),
          }),
        ),
      );
    }),
);

it.effect(
  "charges capacity atomically across simultaneous arrivals and refuses failed SQLite writes",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      yield* Effect.gen(function* () {
        yield* seed;
        const ingress = yield* Ingress.RelayHookIngress;
        const [one, two] = yield* Effect.all([ingress.receive(request), ingress.receive(request)], {
          concurrency: 2,
        });
        assert.deepEqual([one.kind, two.kind].sort(), ["capacity", "held"]);
        const { sql } = yield* Store.RelayStore;
        yield* sql`CREATE TRIGGER test_break_hold BEFORE INSERT ON relay_hook_deliveries
        BEGIN SELECT RAISE(ABORT, 'storage fixture'); END`;
        assert.deepEqual(
          yield* ingress.receive({
            ...request,
            hookId: "other",
            rawTarget: "/api/relay-hooks/other/token?",
          }),
          { kind: "storage", status: 503 },
        );
        assert.deepEqual(yield* sql`SELECT count(*) AS total FROM relay_hook_deliveries`, [
          { total: 1 },
        ]);
      }).pipe(Effect.provide(runtime(home, { capacity: { perHook: 1 } })));
    }),
);

it.effect(
  "passes the scoped authorization signal to a held exchange and stops retrying it on revocation",
  () =>
    Effect.gen(function* () {
      const controller = yield* makePolicyController;
      const home = yield* makeHome;
      const started = yield* Deferred.make<AbortSignal | undefined>();
      let sends = 0;
      let scopesClosed = 0;
      yield* Effect.gen(function* () {
        yield* seed;
        const ingress = yield* Ingress.RelayHookIngress;
        const store = yield* Inbox.RelayHookStore;
        const held = yield* ingress.receive(request);
        if (held.kind !== "held") return assert.fail();
        assert.equal(scopesClosed, 2);
        yield* TestClock.adjust("10 seconds");
        const worker = yield* ingress.dispatchDue().pipe(Effect.forkChild);
        assert.equal(yield* Deferred.await(started), controller.signal);
        controller.abort();
        assert.equal(yield* Fiber.join(worker), receiptWindowMs);
        assert.deepEqual(yield* store.getOutcome(held.deliveryId), {
          kind: "unknown",
          status: 404,
        });
        assert.equal(sends, 2);
        assert.equal(scopesClosed, 3);
      }).pipe(
        Effect.provide(
          runtime(home, {
            resolvePolicy: () =>
              Effect.acquireRelease(
                Effect.succeed({ holdEnabled: true, revision: "v1", signal: controller.signal }),
                () =>
                  Effect.sync(() => {
                    scopesClosed += 1;
                  }),
              ),
            deliver: (_delivery, signal) =>
              Effect.suspend(() => {
                sends += 1;
                const retry = Effect.succeed({
                  kind: "retry",
                  status: 503,
                  possiblyAdmitted: true,
                } as const);
                if (sends === 1) return retry;
                return Deferred.succeed(started, signal).pipe(
                  Effect.andThen(
                    Effect.callback<{
                      readonly kind: "retry";
                      readonly status: 503;
                      readonly possiblyAdmitted: true;
                    }>((resume) => {
                      if (signal?.aborted) return resume(retry);
                      const canceled = () => resume(retry);
                      signal?.addEventListener("abort", canceled, { once: true });
                      return Effect.sync(() => signal?.removeEventListener("abort", canceled));
                    }),
                  ),
                );
              }),
          }),
        ),
      );
    }),
);

it.effect(
  "checks current hold permission on the writer even with a stale authorization callback",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const shared = Store.layer(home);
      yield* Effect.gen(function* () {
        yield* seed;
        const { sql } = yield* Store.RelayStore;
        const inbox = Ingress.layer({
          resolvePolicy: () => Effect.succeed({ holdEnabled: true, revision: "v1" }),
          deliver: () =>
            sql`UPDATE relay_hook_policies SET hold_enabled = 0 WHERE hook_id = ${request.hookId}`.pipe(
              Effect.orDie,
              Effect.as({ kind: "retry", status: 503, possiblyAdmitted: true }),
            ),
        }).pipe(Layer.provide(Inbox.layer));

        yield* Effect.gen(function* () {
          const ingress = yield* Ingress.RelayHookIngress;
          assert.deepEqual(yield* ingress.receive(request), { kind: "disabled", status: 404 });
          assert.deepEqual(yield* sql`SELECT count(*) AS total FROM relay_hook_deliveries`, [
            { total: 0 },
          ]);
        }).pipe(Effect.provide(inbox));
      }).pipe(Effect.provide(shared));
    }),
);

it.effect("keeps the confirmed outcome when enrollment is deleted during a held exchange", () =>
  Effect.gen(function* () {
    const controller = yield* makePolicyController;
    const home = yield* makeHome;
    const started = yield* Deferred.make<Ingress.RelayHookDelivery>();
    const reply = yield* Deferred.make<Ingress.RelayHookDeliveryResult>();
    let sends = 0;
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const store = yield* Inbox.RelayHookStore;
      const held = yield* ingress.receive(request);
      if (held.kind !== "held") return assert.fail();
      yield* TestClock.adjust("10 seconds");
      const worker = yield* ingress.dispatchDue().pipe(Effect.forkChild);
      assert.equal((yield* Deferred.await(started)).deliveryId, held.deliveryId);

      const { sql } = yield* Store.RelayStore;
      yield* sql`DELETE FROM relay_environments WHERE environment_id = ${request.environmentId}`;
      controller.abort();
      yield* Deferred.succeed(reply, { kind: "admitted", status: 202 });
      assert.equal(yield* Fiber.join(worker), receiptWindowMs);
      assert.deepEqual(yield* store.getOutcome(held.deliveryId), { kind: "admitted", status: 202 });
      assert.equal(sends, 2);
    }).pipe(
      Effect.provide(
        runtime(home, {
          resolvePolicy: () =>
            Effect.succeed({ holdEnabled: true, revision: "v1", signal: controller.signal }),
          deliver: (delivery) =>
            Effect.suspend<Ingress.RelayHookDeliveryResult, never, never>(() =>
              ++sends === 1
                ? Effect.succeed({ kind: "retry", status: 429, possiblyAdmitted: false })
                : Deferred.succeed(started, delivery).pipe(Effect.andThen(Deferred.await(reply))),
            ),
        }),
      ),
    );
  }),
);

it.effect("recovers a revoked interrupted exchange as unknown without dispatching it again", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    const started = yield* Deferred.make<void>();
    let sends = 0;
    const held = yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const held = yield* ingress.receive(request);
      if (held.kind !== "held") return assert.fail();
      yield* TestClock.adjust("10 seconds");
      const worker = yield* ingress.dispatchDue().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const { sql } = yield* Store.RelayStore;
      yield* sql`DELETE FROM relay_environments WHERE environment_id = ${request.environmentId}`;
      yield* Fiber.interrupt(worker);
      return held;
    }).pipe(
      Effect.provide(
        runtime(home, {
          deliver: () =>
            Effect.suspend(() =>
              ++sends === 1
                ? Effect.succeed({ kind: "retry", status: 429, possiblyAdmitted: false })
                : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            ),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const ingress = yield* Ingress.RelayHookIngress;
      const store = yield* Inbox.RelayHookStore;
      assert.equal(yield* ingress.dispatchDue(), receiptWindowMs);
      assert.deepEqual(yield* store.getOutcome(held.deliveryId), { kind: "unknown", status: 404 });
      assert.equal(sends, 2);
    }).pipe(
      Effect.provide(runtime(home, { deliver: () => Effect.die("revoked delivery retried") })),
    );
  }),
);

it.effect("limits each hook and environment before delivery or offline hold", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    let sends = 0;
    yield* Effect.gen(function* () {
      yield* seed;
      const { sql } = yield* Store.RelayStore;
      const otherEnvironment = EnvironmentId.make("other-environment");
      yield* sql`INSERT INTO relay_environments (environment_id, record_json)
        VALUES (${otherEnvironment}, '{}')`;
      const hooks = Array.from({ length: 10 }, (_, index) => `hook-${index}`);
      for (const hook of hooks) {
        yield* sql`INSERT INTO relay_hook_policies
          (environment_id, hook_id, generation, revision, enabled, hold_enabled)
          VALUES (${request.environmentId}, ${hook}, 1, 'v1', 1, 1)`;
      }
      yield* sql`INSERT INTO relay_hook_policies
        (environment_id, hook_id, generation, revision, enabled, hold_enabled)
        VALUES (${otherEnvironment}, ${request.hookId}, 1, 'v1', 1, 1)`;

      const ingress = yield* Ingress.RelayHookIngress;
      for (let attempt = 0; attempt < 60; attempt++) {
        assert.equal((yield* ingress.receive(request)).kind, "held");
      }
      yield* TestClock.adjust("10 seconds");
      assert.deepEqual(
        yield* ingress.receive({ ...request, rawTarget: "/api/relay-hooks/hook%3Aid/another" }),
        { kind: "rate-limited", status: 429, retryAfter: "50" },
      );
      for (const hook of hooks.slice(0, 9)) {
        const next = { ...request, hookId: hook, rawTarget: `/api/relay-hooks/${hook}/token` };
        for (let attempt = 0; attempt < (hook === "hook-8" ? 59 : 60); attempt++) {
          assert.equal((yield* ingress.receive(next)).kind, "held");
        }
      }
      assert.deepEqual(
        yield* ingress.receive({
          ...request,
          hookId: "hook-9",
          rawTarget: "/api/relay-hooks/hook-9/token",
        }),
        { kind: "rate-limited", status: 429, retryAfter: "50" },
      );
      assert.equal(sends, 599);
      assert.lengthOf(yield* sql`SELECT 1 FROM relay_hook_deliveries`, 599);
      assert.equal(
        (yield* ingress.receive({ ...request, environmentId: otherEnvironment })).kind,
        "held",
      );
      yield* TestClock.adjust("50 seconds");
      assert.equal((yield* ingress.receive(request)).kind, "held");
    }).pipe(
      Effect.provide(
        runtime(home, {
          deliver: () =>
            Effect.sync(() => {
              sends += 1;
              return { kind: "retry", status: 503, possiblyAdmitted: true };
            }),
        }),
      ),
    );
  }),
);

it.effect.each([false, true])(
  "keeps lost replies distinct from confirmed offline attempts through hold expiry (%s)",
  (possiblyAdmitted) =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      let attempts = 0;
      yield* Effect.gen(function* () {
        yield* seed;
        const ingress = yield* Ingress.RelayHookIngress;
        const store = yield* Inbox.RelayHookStore;
        const held = yield* ingress.receive(request);
        if (held.kind !== "held") return assert.fail();
        yield* TestClock.adjust("10 seconds");
        yield* ingress.dispatchDue();
        yield* TestClock.adjust(Inbox.holdWindowMs - 10_000);
        yield* ingress.dispatchDue();
        assert.deepEqual(yield* store.getOutcome(held.deliveryId), {
          kind: possiblyAdmitted ? "unknown" : "rejected",
          status: 410,
        });
        assert.equal(attempts, 2);
      }).pipe(
        Effect.provide(
          runtime(home, {
            deliver: () =>
              Effect.sync(() => {
                attempts += 1;
                return {
                  kind: "retry",
                  status: 503,
                  possiblyAdmitted: attempts === 1 && possiblyAdmitted,
                };
              }),
          }),
        ),
      );
    }),
);

it.effect.each([
  ["revoked", "bytesPerEnvironment"],
  ["revoked", "totalBytes"],
  ["expired", "bytesPerEnvironment"],
  ["expired", "totalBytes"],
] as const)("charges retained %s payloads against %s until scrubbed", ([retired, budget]) =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    let revision = "v1";
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const { sql } = yield* Store.RelayStore;
      const otherEnvironment = EnvironmentId.make("other-environment");
      yield* sql`INSERT INTO relay_environments (environment_id, record_json)
          VALUES (${otherEnvironment}, '{}')`;
      yield* sql`INSERT INTO relay_hook_policies
          (environment_id, hook_id, generation, revision, enabled, hold_enabled)
          VALUES (${otherEnvironment}, ${request.hookId}, 1, 'v1', 1, 1)`;
      assert.equal((yield* ingress.receive(request)).kind, "held");
      if (retired === "expired") yield* TestClock.adjust(Inbox.holdWindowMs);
      else {
        revision = "v2";
        yield* sql`UPDATE relay_hook_policies SET revision = 'v2'
            WHERE environment_id = ${request.environmentId}`;
      }

      const next =
        budget === "totalBytes" ? { ...request, environmentId: otherEnvironment } : request;
      assert.equal((yield* ingress.receive(next)).kind, "capacity");
      yield* ingress.dispatchDue();
      assert.equal((yield* ingress.receive(next)).kind, "held");
    }).pipe(
      Effect.provide(
        runtime(home, {
          capacity: { [budget]: 512 },
          resolvePolicy: (target) =>
            Effect.sync(() => ({
              holdEnabled: true,
              revision: target.environmentId === request.environmentId ? revision : "v1",
            })),
        }),
      ),
    );
  }),
);

it.effect("releases old revision quota immediately after turning hold off and back on", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    let revision = "v1";
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const store = yield* Inbox.RelayHookStore;
      const first = yield* ingress.receive(request);
      if (first.kind !== "held") return assert.fail();

      const { sql } = yield* Store.RelayStore;
      yield* sql`UPDATE relay_hook_policies SET revision = 'v2', hold_enabled = 0`;
      revision = "v3";
      yield* sql`UPDATE relay_hook_policies SET revision = ${revision}, hold_enabled = 1`;
      const second = yield* ingress.receive(request);
      assert.equal(second.kind, "held");
      yield* ingress.dispatchDue();
      assert.deepEqual(yield* store.getOutcome(first.deliveryId), {
        kind: "rejected",
        status: 404,
      });
      assert.deepEqual(
        yield* sql`SELECT body, raw_target, headers FROM relay_hook_deliveries
          WHERE delivery_id = ${first.deliveryId}`,
        [{ body: null, raw_target: null, headers: null }],
      );
    }).pipe(
      Effect.provide(
        runtime(home, {
          capacity: { perHook: 1, perEnvironment: 1 },
          resolvePolicy: () => Effect.sync(() => ({ holdEnabled: true, revision })),
          deliver: () =>
            Effect.succeed({
              kind: "retry",
              status: 429,
              possiblyAdmitted: false,
              retryAfter: "30000",
            }),
        }),
      ),
    );
  }),
);

it.effect("refuses an expired hold after waiting for the SQLite writer", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    yield* Effect.gen(function* () {
      yield* seed;
      const store = yield* Inbox.RelayHookStore;
      const { sql, relayId } = yield* Store.RelayStore;
      const receivedAt = DateTime.formatIso(yield* DateTime.now);
      const writerAcquired = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* sql
        .withTransaction(
          Deferred.succeed(writerAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(writerAcquired);

      const blockedHold = yield* store
        .hold(
          { ...request, relayId, deliveryId: "blocked-hold", receivedAt },
          Inbox.holdWindowMs,
          "v1",
          { perHook: 1, perEnvironment: 1, bytesPerEnvironment: 1024, totalBytes: 1024 },
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("24 hours");
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);
      assert.equal(yield* Fiber.join(blockedHold), "expired");
      assert.isNull(yield* store.getOutcome("blocked-hold"));
    }).pipe(Effect.provide(runtime(home)));
  }),
);

it.effect("bounds receipt pruning and hold expiry and schedules the remaining cleanup", () =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    yield* Effect.gen(function* () {
      yield* seed;
      const ingress = yield* Ingress.RelayHookIngress;
      const { sql, relayId } = yield* Store.RelayStore;
      yield* TestClock.adjust("7 days");
      const now = yield* Clock.currentTimeMillis;
      yield* sql`WITH RECURSIVE ids(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM ids WHERE n < 21)
        INSERT INTO relay_hook_deliveries (relay_id, delivery_id, environment_id, hook_id,
          received_at, kind, status)
        SELECT ${relayId}, 'old-' || n, ${request.environmentId}, ${request.hookId}, 0, 'admitted', 202
        FROM ids`;
      yield* sql`WITH RECURSIVE ids(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM ids WHERE n < 21)
        INSERT INTO relay_hook_deliveries (relay_id, delivery_id, environment_id, hook_id,
          received_at, kind, status, due_at, revision, method, raw_target, headers, body, charge)
        SELECT ${relayId}, 'held-' || n, ${request.environmentId}, ${request.hookId},
          ${now - Inbox.holdWindowMs}, 'held', 202, ${now + 10_000}, 'v1',
          'POST', ${request.rawTarget}, '{}', x'01', 256
        FROM ids`;

      assert.equal((yield* ingress.receive(request)).kind, "admitted");
      assert.lengthOf(yield* sql`SELECT 1 FROM relay_hook_deliveries WHERE received_at = 0`, 21);
      assert.equal(yield* ingress.dispatchDue(), now);
      assert.lengthOf(yield* sql`SELECT 1 FROM relay_hook_deliveries WHERE received_at = 0`, 1);
      assert.lengthOf(yield* sql`SELECT 1 FROM relay_hook_deliveries WHERE kind = 'held'`, 1);
      assert.equal(yield* ingress.dispatchDue(), now - Inbox.holdWindowMs + receiptWindowMs);
      assert.isEmpty(
        yield* sql`SELECT 1 FROM relay_hook_deliveries WHERE received_at = 0 OR kind = 'held'`,
      );
    }).pipe(
      Effect.provide(
        runtime(home, {
          deliver: (delivery) =>
            delivery.deliveryId.startsWith("held-")
              ? Effect.die("expired delivery retried")
              : Effect.succeed({ kind: "admitted", status: 202 }),
        }),
      ),
    );
  }),
);

it.effect(
  "persists a confirmed immediate reply when its caller is interrupted waiting for the writer",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();
      const recording = yield* Deferred.make<string>();
      const writerReady = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const observedStore = Layer.effect(
        Inbox.RelayHookStore,
        Effect.gen(function* () {
          const store = yield* Inbox.RelayHookStore;
          return Inbox.RelayHookStore.of({
            ...store,
            record: (delivery, outcome) =>
              Deferred.succeed(recording, delivery.deliveryId).pipe(
                Effect.andThen(store.record(delivery, outcome)),
              ),
          });
        }),
      ).pipe(Layer.provide(Inbox.layer));
      yield* Effect.gen(function* () {
        yield* seed;
        const { sql } = yield* Store.RelayStore;
        const ingress = yield* Ingress.RelayHookIngress;
        const store = yield* Inbox.RelayHookStore;
        const receiving = yield* ingress.receive(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const writer = yield* sql
          .withTransaction(
            Deferred.succeed(writerReady, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWriter)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerReady);
        yield* Deferred.succeed(reply, undefined);
        const id = yield* Deferred.await(recording);
        // Interrupt before releasing the writer without awaiting the masked receipt write.
        yield* Effect.sync(() => receiving.interruptUnsafe());
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(writer);
        yield* Fiber.await(receiving);
        assert.deepEqual(yield* store.getOutcome(id), { kind: "admitted", status: 202 });
      }).pipe(
        Effect.provide(
          Ingress.layer({
            resolvePolicy: () => Effect.succeed({ holdEnabled: true, revision: "v1" }),
            deliver: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(reply)),
                Effect.as({ kind: "admitted", status: 202 }),
              ),
          }).pipe(Layer.provideMerge(observedStore), Layer.provideMerge(Store.layer(home))),
        ),
      );
    }),
);
