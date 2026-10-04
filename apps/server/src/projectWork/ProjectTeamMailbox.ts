import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const DeliveryId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const isDeliveryId = Schema.is(DeliveryId);

export class ProjectTeamMailboxError extends Schema.TaggedError<ProjectTeamMailboxError>()(
  "ProjectTeamMailboxError",
  { reason: Schema.String },
) {}

export type ProjectTeamMailboxInspection<Receipt extends object> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Consumed"; readonly receipt: Receipt }
  | { readonly _tag: "Uncertain" }
  | { readonly _tag: "Unavailable" };

export type ProjectTeamMailboxConsumption<Receipt extends object, Error> =
  | { readonly _tag: "Consumed"; readonly receipt: Receipt }
  | { readonly _tag: "Uncertain"; readonly cause: Cause.Cause<Error> };

/** Root owns immutable targets, operation identities, receipts, accounting and current authority. */
export interface ProjectTeamMailboxPorts<
  Claim extends object,
  Receipt extends object,
  Error,
  Services = never,
> {
  // Committed original delivery IDs, ordered by exact binary string order. Discovery grants nothing.
  readonly readPage: (input: {
    readonly afterDeliveryId?: string;
    readonly limit: number;
  }) => Effect.Effect<readonly string[], Error, Services>;
  // Register a durable fenced claim for this exact ID. Join owned cleanup before returning and
  // preserve callback failure together with cleanup failure. Failed cleanup retains durable ownership,
  // uncertainty and any actual Consumed receipt. Keep the caller's service/scope lifetime.
  readonly withClaim: <A, E, R>(
    deliveryId: string,
    run: (claim: Claim) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | { readonly _tag: "Busy" }, Error | E, Services | R>;
  readonly inspect: (
    claim: Claim,
  ) => Effect.Effect<ProjectTeamMailboxInspection<Receipt>, Error, Services>;
  // Before native entry, Root persists the original target, operation ID/hash and claim fence;
  // rechecks sender/recipient, gates, lease, safe boundary, depth and immutable root budget; and
  // invokes only that original operation. Enqueue/transport acknowledgment is never Consumed.
  readonly consume: (
    claim: Claim,
  ) => Effect.Effect<ProjectTeamMailboxConsumption<Receipt, Error>, Error, Services>;
  // Atomically validate the actual native/accounting receipt and approved message policy in SQL.
  // Replay is idempotent even if the previous commit succeeded but its response was lost.
  readonly commitConsumed: (claim: Claim, receipt: Receipt) => Effect.Effect<void, Error, Services>;
  // Retain the original target, operation identity and ownership. Never discard a known native
  // Consumed receipt: inspect must still return it for commit-only reconciliation.
  readonly recordUncertain: (
    claim: Claim,
    cause: Cause.Cause<Error>,
  ) => Effect.Effect<void, Error, Services>;
}

/** One bounded page per sweep; cursor and local serialization confer no durable authority. */
export function makeProjectTeamMailbox<
  Claim extends object,
  Receipt extends object,
  Error,
  Services = never,
>(
  ports: ProjectTeamMailboxPorts<Claim, Receipt, Error, Services>,
  options: { readonly pageSize?: number } = {},
) {
  const pageSize = options.pageSize ?? 128;
  const serial = Semaphore.makeUnsafe(1);
  let afterDeliveryId: string | undefined;
  const reject = (reason: string) => new ProjectTeamMailboxError({ reason });

  const deliver = Effect.fn("ProjectTeamMailbox.deliver")(function* (deliveryId: string) {
    return yield* Effect.suspend(() =>
      ports.withClaim(deliveryId, (claim) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let entered = false;
            const delivered = yield* restore(
              Effect.gen(function* () {
                const inspected = yield* Effect.suspend(() => ports.inspect(claim));
                if (inspected._tag === "Unavailable" || inspected._tag === "Uncertain")
                  return inspected._tag;
                let receipt: Receipt;
                if (inspected._tag === "Consumed") {
                  entered = true;
                  receipt = inspected.receipt;
                } else {
                  const consumed = yield* Effect.suspend(() => {
                    entered = true;
                    return ports.consume(claim);
                  });
                  if (consumed._tag === "Uncertain") return yield* Effect.failCause(consumed.cause);
                  receipt = consumed.receipt;
                }
                yield* Effect.suspend(() => ports.commitConsumed(claim, receipt));
                return "Committed" as const;
              }),
            ).pipe(Effect.exit);
            if (Exit.isSuccess(delivered)) return { _tag: delivered.value };
            let cause = delivered.cause;
            if (entered) {
              const recorded = yield* Effect.suspend(() =>
                ports.recordUncertain(claim, cause),
              ).pipe(Effect.exit);
              if (Exit.isFailure(recorded))
                cause = Cause.fromReasons([...cause.reasons, ...recorded.cause.reasons]);
            }
            return yield* Effect.failCause(cause);
          }),
        ),
      ),
    );
  });

  const sweep = Effect.fn("ProjectTeamMailbox.sweep")(function* () {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 128)
      return yield* reject("Mailbox page size must be between 1 and 128");
    const read = yield* Effect.suspend(() =>
      ports.readPage({
        ...(afterDeliveryId === undefined ? {} : { afterDeliveryId }),
        limit: pageSize,
      }),
    );
    if (read.length > pageSize) return yield* reject("Root exceeded the mailbox page bound");
    const page = [...read];
    let previous = afterDeliveryId;
    // Validate the complete page before claiming even its first delivery.
    for (const id of page) {
      if (!isDeliveryId(id)) return yield* reject("Root returned an invalid original delivery ID");
      if (previous !== undefined && id <= previous)
        return yield* reject("Root returned duplicate or unordered delivery IDs");
      previous = id;
    }
    const outcomes: {
      readonly deliveryId: string;
      readonly status: "Committed" | "Busy" | "Uncertain" | "Unavailable";
    }[] = [];
    for (const deliveryId of page) {
      const result = yield* deliver(deliveryId).pipe(Effect.exit);
      if (Exit.isFailure(result)) {
        // A failing row must not pin later work forever. End-wrap revisits it; interruption keeps
        // the last completed position so the original interrupted row remains discoverable.
        if (!Cause.hasInterrupts(result.cause)) afterDeliveryId = deliveryId;
        return yield* Effect.failCause(result.cause);
      }
      afterDeliveryId = deliveryId;
      outcomes.push({ deliveryId, status: result.value._tag });
    }
    if (page.length < pageSize) afterDeliveryId = undefined;
    return { outcomes, ...(afterDeliveryId === undefined ? {} : { afterDeliveryId }) };
  });

  return { sweep: () => serial.withPermits(1)(sweep()) };
}
