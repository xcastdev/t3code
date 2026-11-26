import type { EnvironmentId } from "@t3tools/contracts";
import type { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayStorageError, RelayStore, storageError } from "./RelayStore.ts";

export const holdWindowMs = 24 * 60 * 60 * 1_000;
const receiptWindowMs = 7 * holdWindowMs;
const cleanupBatchSize = 20;
const policyCheckIntervalMs = 60_000;

export interface RelayHookTarget {
  readonly environmentId: EnvironmentId;
  readonly hookId: string;
}

export interface RelayHookDelivery extends RelayHookTarget {
  readonly relayId: SelfHostedRelayId;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  readonly rawTarget: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

type Outcome = {
  readonly kind: "admitted" | "noop" | "duplicate" | "coalesced" | "rejected";
  readonly status: number;
};

type StoredOutcome =
  | Outcome
  | { readonly kind: "held"; readonly status: 202 }
  | { readonly kind: "unknown"; readonly status: 404 | 410 };

export interface RelayHookCapacity {
  readonly perHook: number;
  readonly perEnvironment: number;
  readonly bytesPerEnvironment: number;
  readonly totalBytes: number;
}

interface Pending extends RelayHookDelivery {
  readonly revision: string;
}

export class RelayHookStore extends Context.Service<
  RelayHookStore,
  {
    readonly relayId: SelfHostedRelayId;
    readonly isAuthorized: (
      target: RelayHookTarget,
      revision: string,
      requireHold: boolean,
    ) => Effect.Effect<boolean, RelayStorageError>;
    readonly hold: (
      delivery: RelayHookDelivery,
      dueAt: number,
      revision: string,
      capacity: RelayHookCapacity,
      signal?: AbortSignal,
      possiblyAdmitted?: boolean,
    ) => Effect.Effect<"held" | "capacity" | "disabled" | "expired", RelayStorageError>;
    readonly record: (
      delivery: RelayHookDelivery,
      outcome: Outcome,
    ) => Effect.Effect<void, RelayStorageError>;
    readonly beginAttempt: (
      delivery: Pick<Pending, "deliveryId" | "receivedAt" | "revision">,
      signal?: AbortSignal,
    ) => Effect.Effect<{ readonly possiblyAdmitted: boolean } | null, RelayStorageError>;
    readonly retire: (
      deliveryId: string,
      status: 404 | 410,
      possiblyAdmitted?: boolean,
    ) => Effect.Effect<void, RelayStorageError>;
    readonly finish: (
      deliveryId: string,
      outcome: Outcome,
    ) => Effect.Effect<void, RelayStorageError>;
    readonly postpone: (
      deliveryId: string,
      dueAt: number,
      possiblyAdmitted: boolean,
    ) => Effect.Effect<void, RelayStorageError>;
    readonly sweep: () => Effect.Effect<boolean, RelayStorageError>;
    readonly due: (now: number) => Effect.Effect<Pending | null, RelayStorageError>;
    readonly nextDue: () => Effect.Effect<number | null, RelayStorageError>;
    readonly getOutcome: (
      deliveryId: string,
    ) => Effect.Effect<StoredOutcome | null, RelayStorageError>;
  }
>()("@t3tools/relay-core/RelayHookStore") {}

const headerJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeHeaders = Schema.encodeSync(headerJson);
const decodeHeaders = Schema.decodeEffect(headerJson);

const make = Effect.gen(function* () {
  const { sql, relayId } = yield* RelayStore;
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`
      CREATE TABLE IF NOT EXISTS relay_hook_deliveries (
        relay_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('held', 'admitted', 'noop', 'duplicate', 'coalesced', 'rejected')),
        status INTEGER NOT NULL,
        due_at INTEGER,
        revision TEXT,
        method TEXT,
        raw_target TEXT,
        headers TEXT,
        body BLOB,
        charge INTEGER,
        attempt_unconfirmed INTEGER CHECK (attempt_unconfirmed IN (0, 1)),
        PRIMARY KEY (relay_id, delivery_id),
        CHECK (
          (kind = 'held' AND status = 202 AND due_at IS NOT NULL AND revision IS NOT NULL AND charge > 0
            AND charge IS NOT NULL AND method IN ('GET', 'POST', 'PUT', 'PATCH') AND method IS NOT NULL
            AND raw_target IS NOT NULL AND headers IS NOT NULL AND body IS NOT NULL)
          OR (kind <> 'held' AND due_at IS NULL AND method IS NULL AND raw_target IS NULL
            AND headers IS NULL AND body IS NULL AND charge IS NULL AND revision IS NULL)
        )
      ) STRICT
    `;
        yield* sql`CREATE INDEX IF NOT EXISTS relay_hooks_due
      ON relay_hook_deliveries (relay_id, due_at) WHERE kind = 'held'`;
        yield* sql`CREATE INDEX IF NOT EXISTS relay_hooks_capacity
      ON relay_hook_deliveries (relay_id, environment_id, hook_id) WHERE kind = 'held'`;
        const [attemptColumn] = yield* sql`
          SELECT 1 FROM pragma_table_info('relay_hook_deliveries') WHERE name = 'attempt_unconfirmed'
        `;
        if (!attemptColumn) {
          yield* sql`ALTER TABLE relay_hook_deliveries ADD COLUMN attempt_unconfirmed INTEGER`;
        }
        yield* sql`DROP TRIGGER IF EXISTS relay_hooks_revoke_enrollment`;
        yield* sql`DROP INDEX IF EXISTS relay_hooks_expiry`;
        yield* sql`CREATE INDEX IF NOT EXISTS relay_hook_hold_expiry
          ON relay_hook_deliveries (relay_id, received_at) WHERE kind = 'held'`;
        yield* sql`CREATE INDEX IF NOT EXISTS relay_hook_receipt_expiry
          ON relay_hook_deliveries (relay_id, received_at) WHERE kind <> 'held'`;
        yield* sql`CREATE VIEW IF NOT EXISTS relay_hook_active_holds AS
          SELECT delivery.rowid AS hold_rowid, delivery.*
          FROM relay_hook_deliveries delivery
          JOIN relay_hook_policies policy
            ON policy.environment_id = delivery.environment_id AND policy.hook_id = delivery.hook_id
            AND policy.revision = delivery.revision AND policy.enabled = 1 AND policy.hold_enabled = 1
          JOIN relay_environments environment ON environment.environment_id = policy.environment_id
          JOIN relay_identity identity ON identity.singleton = 1 AND identity.generation = policy.generation
          WHERE delivery.kind = 'held'`;
      }),
    )
    .pipe(Effect.mapError(storageError));

  const isAuthorized = Effect.fn("RelayHookStore.isAuthorized")(function* (
    target: RelayHookTarget,
    revision: string,
    requireHold: boolean,
  ) {
    const [row] = yield* sql`
      SELECT 1 FROM relay_hook_policies policy
      JOIN relay_environments environment ON environment.environment_id = policy.environment_id
      JOIN relay_identity identity ON identity.singleton = 1 AND identity.generation = policy.generation
      WHERE policy.environment_id = ${target.environmentId} AND policy.hook_id = ${target.hookId}
        AND policy.revision = ${revision} AND policy.enabled = 1
        AND (${requireHold ? 1 : 0} = 0 OR policy.hold_enabled = 1)
    `.pipe(Effect.mapError(storageError));
    return row !== undefined;
  });

  const clearRequest = sql`
    due_at = NULL, method = NULL, raw_target = NULL, headers = NULL,
    body = NULL, charge = NULL, revision = NULL
  `;
  // Legacy held rows can include transmissions made before the attempt marker existed.
  const unknownIfAttempted = sql`attempt_unconfirmed = coalesce(attempt_unconfirmed, 1)`;

  const sweep = Effect.fn("RelayHookStore.sweep")(function* () {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const pruned = yield* sql`DELETE FROM relay_hook_deliveries WHERE rowid IN (
            SELECT rowid FROM relay_hook_deliveries
            WHERE relay_id = ${relayId} AND kind <> 'held' AND received_at <= ${now - receiptWindowMs}
            ORDER BY received_at LIMIT ${cleanupBatchSize}
          ) RETURNING delivery_id`;
          const expired = yield* sql`UPDATE relay_hook_deliveries
            SET kind = 'rejected', status = 410, ${clearRequest}, ${unknownIfAttempted}
            WHERE rowid IN (
              SELECT rowid FROM relay_hook_deliveries
              WHERE relay_id = ${relayId} AND kind = 'held' AND received_at <= ${now - holdWindowMs}
              ORDER BY received_at LIMIT ${cleanupBatchSize}
            ) RETURNING delivery_id`;
          const revoked = yield* sql`UPDATE relay_hook_deliveries
            SET kind = 'rejected', status = 404, ${clearRequest}, ${unknownIfAttempted}
            WHERE rowid IN (
              SELECT delivery.rowid FROM relay_hook_deliveries delivery
              WHERE delivery.relay_id = ${relayId} AND delivery.kind = 'held'
                AND delivery.received_at > ${now - holdWindowMs}
                AND NOT EXISTS (
                  SELECT 1 FROM relay_hook_active_holds active
                  WHERE active.relay_id = delivery.relay_id AND active.delivery_id = delivery.delivery_id
                )
              ORDER BY delivery.received_at LIMIT ${cleanupBatchSize}
            ) RETURNING delivery_id`;
          return [pruned, expired, revoked].some((rows) => rows.length === cleanupBatchSize);
        }),
      )
      .pipe(Effect.mapError(storageError));
  });

  const hold = Effect.fn("RelayHookStore.hold")(function* (
    delivery: RelayHookDelivery,
    dueAt: number,
    revision: string,
    capacity: RelayHookCapacity,
    signal?: AbortSignal,
    possiblyAdmitted = false,
  ) {
    const receivedAt = Date.parse(delivery.receivedAt);
    const headers = encodeHeaders(delivery.headers);
    // Include stored request metadata so empty-body hooks also consume the relay-wide budget.
    const charge =
      delivery.body.byteLength +
      new TextEncoder().encode(headers + delivery.rawTarget).byteLength +
      256;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* isAuthorized(delivery, revision, true)) || signal?.aborted)
            return "disabled" as const;
          const earliest = (yield* Clock.currentTimeMillis) - holdWindowMs;
          if (receivedAt <= earliest) return "expired" as const;
          const rows = yield* sql`
        INSERT INTO relay_hook_deliveries (relay_id, delivery_id, environment_id, hook_id,
          received_at, kind, status, due_at, revision, method, raw_target, headers, body, charge,
          attempt_unconfirmed)
        SELECT ${relayId}, ${delivery.deliveryId}, ${delivery.environmentId}, ${delivery.hookId},
          ${receivedAt}, 'held', 202, ${dueAt}, ${revision}, ${delivery.method}, ${delivery.rawTarget},
          ${headers}, ${delivery.body}, ${charge}, ${possiblyAdmitted ? 1 : 0}
        WHERE (
          SELECT count(*) FROM relay_hook_active_holds
          WHERE relay_id = ${relayId} AND received_at > ${earliest}
            AND environment_id = ${delivery.environmentId} AND hook_id = ${delivery.hookId}
        ) < ${capacity.perHook}
        AND (
          SELECT count(*) FROM relay_hook_active_holds
          WHERE relay_id = ${relayId} AND received_at > ${earliest}
            AND environment_id = ${delivery.environmentId}
        ) < ${capacity.perEnvironment}
        AND (
          SELECT coalesce(sum(charge), 0) FROM relay_hook_deliveries
          WHERE relay_id = ${relayId} AND kind = 'held'
            AND environment_id = ${delivery.environmentId}
        ) + ${charge} <= ${capacity.bytesPerEnvironment}
        AND (
          SELECT coalesce(sum(charge), 0) FROM relay_hook_deliveries
          WHERE relay_id = ${relayId} AND kind = 'held'
        ) + ${charge} <= ${capacity.totalBytes}
        RETURNING delivery_id
      `.pipe(Effect.mapError(storageError));
          return rows.length ? ("held" as const) : ("capacity" as const);
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
  });

  const record = Effect.fn("RelayHookStore.record")(function* (
    delivery: RelayHookDelivery,
    outcome: Outcome,
  ) {
    yield* sql`INSERT INTO relay_hook_deliveries
      (relay_id, delivery_id, environment_id, hook_id, received_at, kind, status)
      VALUES (${relayId}, ${delivery.deliveryId}, ${delivery.environmentId}, ${delivery.hookId},
        ${Date.parse(delivery.receivedAt)}, ${outcome.kind}, ${outcome.status})`.pipe(
      Effect.mapError(storageError),
    );
  });

  const retire = Effect.fn("RelayHookStore.retire")(function* (
    deliveryId: string,
    status: 404 | 410,
    possiblyAdmitted?: boolean,
  ) {
    const unconfirmed = possiblyAdmitted === undefined ? null : Number(possiblyAdmitted);
    yield* sql`UPDATE relay_hook_deliveries
      SET kind = 'rejected', status = ${status}, ${clearRequest},
        attempt_unconfirmed = coalesce(${unconfirmed}, attempt_unconfirmed, 1)
      WHERE relay_id = ${relayId} AND delivery_id = ${deliveryId} AND kind = 'held'`.pipe(
      Effect.mapError(storageError),
    );
  });

  const beginAttempt = Effect.fn("RelayHookStore.beginAttempt")(function* (
    delivery: Pick<Pending, "deliveryId" | "receivedAt" | "revision">,
    signal?: AbortSignal,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (Date.parse(delivery.receivedAt) <= now - holdWindowMs) {
            yield* retire(delivery.deliveryId, 410);
            return null;
          }
          const [active] = yield* sql<{ attempt_unconfirmed: number | null }>`
            SELECT attempt_unconfirmed FROM relay_hook_active_holds
            WHERE relay_id = ${relayId} AND delivery_id = ${delivery.deliveryId}
              AND revision = ${delivery.revision}
          `;
          if (!active || signal?.aborted) {
            yield* retire(delivery.deliveryId, 404);
            return null;
          }
          yield* sql`UPDATE relay_hook_deliveries SET attempt_unconfirmed = 1
          WHERE relay_id = ${relayId} AND delivery_id = ${delivery.deliveryId}`;
          return { possiblyAdmitted: active.attempt_unconfirmed !== 0 };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
  });

  const finish = Effect.fn("RelayHookStore.finish")(function* (
    deliveryId: string,
    outcome: Outcome,
  ) {
    const [finished] = yield* sql`UPDATE relay_hook_deliveries
      SET kind = ${outcome.kind}, status = ${outcome.status}, ${clearRequest}, attempt_unconfirmed = NULL
      WHERE relay_id = ${relayId} AND delivery_id = ${deliveryId}
        AND kind = 'held' AND attempt_unconfirmed = 1
      RETURNING delivery_id`.pipe(Effect.mapError(storageError));
    if (!finished) return yield* new RelayStorageError({ reason: "invalid-state" });
  });

  const postpone = Effect.fn("RelayHookStore.postpone")(function* (
    deliveryId: string,
    dueAt: number,
    possiblyAdmitted: boolean,
  ) {
    yield* sql`UPDATE relay_hook_deliveries SET due_at = ${dueAt},
      attempt_unconfirmed = ${possiblyAdmitted ? 1 : 0}
      WHERE relay_id = ${relayId} AND delivery_id = ${deliveryId} AND kind = 'held'`.pipe(
      Effect.mapError(storageError),
    );
  });

  const due = Effect.fn("RelayHookStore.due")(function* (now: number) {
    const [row] = yield* sql<{
      environment_id: EnvironmentId;
      hook_id: string;
      delivery_id: string;
      received_at: number;
      revision: string;
      method: RelayHookDelivery["method"];
      raw_target: string;
      headers: string;
      body: Uint8Array;
    }>`
      SELECT environment_id, hook_id, delivery_id, received_at, revision, method, raw_target, headers, body
      FROM relay_hook_active_holds
      WHERE relay_id = ${relayId} AND due_at <= ${now} AND received_at > ${now - holdWindowMs}
      ORDER BY due_at, received_at, delivery_id LIMIT 1
    `.pipe(Effect.mapError(storageError));
    if (!row) return null;
    return {
      relayId,
      environmentId: row.environment_id,
      hookId: row.hook_id,
      deliveryId: row.delivery_id,
      receivedAt: DateTime.formatIso(DateTime.makeUnsafe(row.received_at)),
      revision: row.revision,
      method: row.method,
      rawTarget: row.raw_target,
      headers: yield* decodeHeaders(row.headers).pipe(
        Effect.mapError((cause) => new RelayStorageError({ reason: "invalid-state", cause })),
      ),
      body: row.body,
    } satisfies Pending;
  });

  const nextDue = Effect.fn("RelayHookStore.nextDue")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [row] = yield* sql<{ held_at: number | null; receipt_at: number | null }>`
      SELECT
        (SELECT due_at FROM relay_hook_deliveries
          WHERE relay_id = ${relayId} AND kind = 'held' ORDER BY due_at LIMIT 1) AS held_at,
        (SELECT received_at FROM relay_hook_deliveries
          WHERE relay_id = ${relayId} AND kind <> 'held' ORDER BY received_at LIMIT 1) AS receipt_at
    `.pipe(Effect.mapError(storageError));
    const held =
      row?.held_at == null ? Infinity : Math.min(row.held_at, now + policyCheckIntervalMs);
    const receipt = row?.receipt_at == null ? Infinity : row.receipt_at + receiptWindowMs;
    const next = Math.min(held, receipt);
    return Number.isFinite(next) ? next : null;
  });

  const getOutcome = Effect.fn("RelayHookStore.getOutcome")(function* (deliveryId: string) {
    const now = yield* Clock.currentTimeMillis;
    const [row] = yield* sql<StoredOutcome>`
      SELECT CASE WHEN kind = 'rejected' AND attempt_unconfirmed = 1
        THEN 'unknown' ELSE kind END AS kind, status FROM relay_hook_deliveries
      WHERE relay_id = ${relayId} AND delivery_id = ${deliveryId}
        AND received_at > ${now - receiptWindowMs}
    `.pipe(Effect.mapError(storageError));
    return row ?? null;
  });

  return RelayHookStore.of({
    relayId,
    isAuthorized,
    hold,
    record,
    beginAttempt,
    retire,
    finish,
    postpone,
    sweep,
    due,
    nextDue,
    getOutcome,
  });
});

export const layer = Layer.effect(RelayHookStore, make);
