import {
  isSelfHostedRelayHookApplicationHeader,
  SelfHostedRelayHookMethod,
} from "@t3tools/contracts/selfHostedRelayHooks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { RelayStorageError } from "./RelayStore.ts";
import {
  holdWindowMs,
  RelayHookStore,
  type RelayHookCapacity,
  type RelayHookDelivery,
  type RelayHookTarget,
} from "./RelayHookStore.ts";

export type { RelayHookDelivery } from "./RelayHookStore.ts";

type RelayHookRequest = Omit<
  RelayHookDelivery,
  "relayId" | "deliveryId" | "receivedAt" | "method"
> & {
  readonly method: string;
};

export interface RelayHookPolicy {
  readonly holdEnabled: boolean;
  readonly signal?: AbortSignal;
  readonly revision: string;
}

export type RelayHookDeliveryResult =
  | {
      readonly kind: "admitted" | "noop" | "duplicate" | "coalesced" | "rejected";
      readonly status: number;
    }
  | {
      readonly kind: "retry";
      readonly status: number;
      readonly retryAfter?: string;
      readonly possiblyAdmitted: boolean;
    };

export type RelayHookIngressResult =
  | (RelayHookDeliveryResult & { readonly deliveryId: string })
  | { readonly kind: "held"; readonly status: 202; readonly deliveryId: string }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly retryAfter: string }
  | { readonly kind: "disabled"; readonly status: 404 }
  | { readonly kind: "capacity" | "storage"; readonly status: 503 }
  | { readonly kind: "invalid"; readonly status: 400 | 405 | 413 };

interface Options {
  readonly resolvePolicy: (
    target: RelayHookTarget,
  ) => Effect.Effect<RelayHookPolicy | null, RelayStorageError, Scope.Scope>;
  readonly deliver: (
    delivery: RelayHookDelivery,
    signal?: AbortSignal,
  ) => Effect.Effect<RelayHookDeliveryResult>;
  readonly retryDelayMs?: number;
  readonly capacity?: Partial<RelayHookCapacity>;
}

export class RelayHookIngress extends Context.Service<
  RelayHookIngress,
  {
    readonly receive: (request: RelayHookRequest) => Effect.Effect<RelayHookIngressResult>;
    readonly dispatchDue: () => Effect.Effect<number | null, RelayStorageError>;
  }
>()("@t3tools/relay-core/RelayHookIngress") {}

const maxBodyBytes = 1_048_576;
const maxHeaderBytes = 32 * 1_024;
const maxBatchSize = 20;
const minuteMs = 60_000;
const hookRateLimit = 60;
const environmentRateLimit = 600;
const defaultCapacity = {
  perHook: 100,
  perEnvironment: 1_000,
  bytesPerEnvironment: 50 * maxBodyBytes,
  totalBytes: 250 * maxBodyBytes,
} satisfies RelayHookCapacity;
const disabled = { kind: "disabled", status: 404 } as const;
const expired = { kind: "rejected", status: 410 } as const;
const isMethod = Schema.is(SelfHostedRelayHookMethod);
const encodeHeaders = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

function matchesHook(rawTarget: string, hookId: string) {
  if (rawTarget.length > 8192 || hookId.length > 256 || hookId.trim() !== hookId) return false;
  const match = /^\/api\/relay-hooks\/([^/?#\\\s]+)\/([^/?#\\\s]+)(?:\?[^#\s]*)?$/u.exec(rawTarget);
  if (!match?.[1] || !match[2]) return false;
  try {
    const decodedHook = decodeURIComponent(match[1]);
    const token = decodeURIComponent(match[2]);
    return (
      decodedHook === hookId &&
      decodedHook !== "." &&
      decodedHook !== ".." &&
      token !== "." &&
      token !== ".."
    );
  } catch {
    return false;
  }
}

function applicationHeaders(headers: Readonly<Record<string, string>>) {
  const entries = Object.entries(headers);
  const nominated = new Set(
    entries
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) =>
        value
          .toLowerCase()
          .split(",")
          .map((name) => name.trim()),
      ),
  );
  return Object.fromEntries(
    entries
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => isSelfHostedRelayHookApplicationHeader(name) && !nominated.has(name)),
  );
}

function nextAttempt(
  result: Extract<RelayHookDeliveryResult, { kind: "retry" }>,
  now: number,
  expiresAt: number,
  fallback: number,
) {
  const retryAfter = result.status === 429 ? result.retryAfter?.trim() : undefined;
  const retryAt = retryAfter
    ? /^\d+$/u.test(retryAfter)
      ? now + Number(retryAfter) * 1_000
      : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/u.test(retryAfter)
        ? Date.parse(retryAfter)
        : Number.NaN
    : Number.NaN;
  return Math.min(expiresAt, Math.max(now + 1, Number.isNaN(retryAt) ? now + fallback : retryAt));
}

const make = Effect.fn("RelayHookIngress.make")(function* (options: Options) {
  const store = yield* RelayHookStore;
  const random = yield* SecureRandom.SecureRandom;
  const dispatcher = yield* Semaphore.make(1);
  const capacity = { ...defaultCapacity, ...options.capacity };
  const retryDelay = options.retryDelayMs ?? 10_000;
  let rateWindow = 0;
  const rateByEnvironment = new Map<
    RelayHookTarget["environmentId"],
    { requests: number; readonly hooks: Map<string, number> }
  >();

  function allowRequest(target: RelayHookTarget, now: number) {
    const window = Math.floor(now / minuteMs);
    if (window !== rateWindow) {
      rateWindow = window;
      rateByEnvironment.clear();
    }
    let budget = rateByEnvironment.get(target.environmentId);
    if (!budget) {
      budget = { requests: 0, hooks: new Map() };
      rateByEnvironment.set(target.environmentId, budget);
    }
    if (budget.requests >= environmentRateLimit) return false;
    budget.requests += 1;
    const requests = budget.hooks.get(target.hookId) ?? 0;
    if (requests >= hookRateLimit) return false;
    budget.hooks.set(target.hookId, requests + 1);
    return true;
  }

  const resolve = Effect.fn("RelayHookIngress.resolvePolicy")(function* (
    target: RelayHookTarget,
    requireHold = false,
  ) {
    const policy = yield* options.resolvePolicy({
      environmentId: target.environmentId,
      hookId: target.hookId,
    });
    return policy &&
      !policy.signal?.aborted &&
      (!requireHold || policy.holdEnabled) &&
      (yield* store.isAuthorized(target, policy.revision, requireHold)) &&
      !policy.signal?.aborted
      ? policy
      : null;
  });

  const receive = Effect.fn("RelayHookIngress.receive")(
    function* (
      request: RelayHookRequest,
    ): Effect.fn.Return<RelayHookIngressResult, RelayStorageError, Scope.Scope> {
      const receivedAt = yield* Clock.currentTimeMillis;
      if (!isMethod(request.method)) return { kind: "invalid", status: 405 };
      if (!matchesHook(request.rawTarget, request.hookId)) return { kind: "invalid", status: 400 };
      if (request.body.byteLength > maxBodyBytes) return { kind: "invalid", status: 413 };
      const headers = applicationHeaders(request.headers);
      if (new TextEncoder().encode(encodeHeaders(headers)).byteLength > maxHeaderBytes) {
        return { kind: "invalid", status: 413 };
      }
      const policy = yield* resolve(request);
      if (!policy || policy.signal?.aborted) return disabled;
      const now = yield* Clock.currentTimeMillis;
      if (!allowRequest(request, now)) {
        return {
          kind: "rate-limited",
          status: 429,
          retryAfter: String(Math.ceil((minuteMs - (now % minuteMs)) / 1_000)),
        };
      }
      const deliveryId = yield* random.uuidV4();
      const delivery: RelayHookDelivery = {
        environmentId: request.environmentId,
        hookId: request.hookId,
        relayId: store.relayId,
        deliveryId,
        receivedAt: DateTime.formatIso(DateTime.makeUnsafe(receivedAt)),
        method: request.method,
        rawTarget: request.rawTarget,
        headers,
        body: new Uint8Array(request.body),
      };
      const result = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* restore(options.deliver(delivery, policy.signal));
          if (result.kind !== "retry") yield* store.record(delivery, result);
          return result;
        }),
      );
      if (result.kind !== "retry") return { ...result, deliveryId };
      if (policy.signal?.aborted) return disabled;
      if (!policy.holdEnabled) return { ...result, deliveryId };
      const current = yield* resolve(request);
      if (
        !current ||
        current.signal?.aborted ||
        policy.signal?.aborted ||
        current.revision !== policy.revision
      ) {
        return disabled;
      }
      if (!current.holdEnabled) return { ...result, deliveryId };

      const retryAt = yield* Clock.currentTimeMillis;
      const dueAt = nextAttempt(result, retryAt, receivedAt + holdWindowMs, retryDelay);
      const held = yield* store.hold(
        delivery,
        dueAt,
        current.revision,
        capacity,
        current.signal,
        result.possiblyAdmitted,
      );
      switch (held) {
        case "held":
          return { kind: "held", status: 202, deliveryId };
        case "capacity":
          return { kind: "capacity", status: 503 };
        case "disabled":
          return disabled;
        case "expired":
          return { ...expired, deliveryId };
      }
    },
    Effect.scoped,
    Effect.catchTags({
      RelayStorageError: (error) =>
        Effect.logWarning("Relay webhook storage unavailable", { reason: error.reason }).pipe(
          Effect.as({ kind: "storage", status: 503 } as const),
        ),
    }),
  );

  const dispatchOne = Effect.fn("RelayHookIngress.dispatchOne")(function* (
    deliveryWithRevision: NonNullable<Effect.Success<ReturnType<typeof store.due>>>,
  ) {
    const { revision, ...delivery } = deliveryWithRevision;
    const expiresAt = Date.parse(delivery.receivedAt) + holdWindowMs;
    const policy = yield* resolve(delivery, true);
    if (!policy || policy.revision !== revision) {
      yield* store.retire(delivery.deliveryId, 404);
      return;
    }
    const attempt = yield* store.beginAttempt(deliveryWithRevision, policy.signal);
    if (!attempt) return;
    // Once a reply arrives, persist it even if dispatcher shutdown is already pending.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (policy.signal?.aborted) {
          yield* store.retire(delivery.deliveryId, 404, attempt.possiblyAdmitted);
          return;
        }
        const result = yield* restore(options.deliver(delivery, policy.signal));
        if (result.kind !== "retry") {
          yield* store.finish(delivery.deliveryId, result);
          return;
        }
        const possiblyAdmitted = attempt.possiblyAdmitted || result.possiblyAdmitted;
        if (policy.signal?.aborted) {
          yield* store.retire(delivery.deliveryId, 404, possiblyAdmitted);
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* store.postpone(
          delivery.deliveryId,
          nextAttempt(result, now, expiresAt, retryDelay),
          possiblyAdmitted,
        );
      }),
    );
  }, Effect.scoped);

  const dispatchDue = Effect.fn("RelayHookIngress.dispatchDue")(function* () {
    const moreCleanup = yield* store.sweep();
    for (let attempt = 0; attempt < maxBatchSize; attempt++) {
      const row = yield* store.due(yield* Clock.currentTimeMillis);
      if (!row) break;
      yield* dispatchOne(row);
    }
    return moreCleanup ? yield* Clock.currentTimeMillis : yield* store.nextDue();
  }, dispatcher.withPermit);

  return RelayHookIngress.of({ receive, dispatchDue });
});

export const layer = (options: Options) =>
  Layer.effect(RelayHookIngress, make(options)).pipe(Layer.provide(SecureRandom.layerWebCrypto));
