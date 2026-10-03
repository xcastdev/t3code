import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  ProjectTeamDispatchOutcome,
  ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatch.ts";

export class ProjectTeamRecoveryError extends Schema.TaggedError<ProjectTeamRecoveryError>()(
  "ProjectTeamRecoveryError",
  { reason: Schema.String },
) {}

export type ProjectTeamRecoveryDiscovery<Error> = {
  readonly dispatchId: string;
  readonly snapshot: Exit.Exit<ProjectTeamDispatchSnapshot, Error>;
};

export type ProjectTeamRecoveryOutcome<Error> =
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Resumed"; readonly fence: ProjectTeamDispatchSnapshot["fence"] }
  | { readonly _tag: "Settled"; readonly cause: Cause.Cause<Error | ProjectTeamRecoveryError> }
  | { readonly _tag: "Quarantined"; readonly cause: Cause.Cause<Error | ProjectTeamRecoveryError> };

/** Root registers claims and validates current authority and physical receipts. Discovery grants none. */
export interface ProjectTeamRecoveryPorts<
  Claim extends object,
  Drain extends object,
  Error,
  Services = never,
> {
  readonly readPage: (input: {
    readonly afterDispatchId?: string;
    readonly limit: number;
  }) => Effect.Effect<readonly ProjectTeamRecoveryDiscovery<Error>[], Error, Services>;
  readonly recordDiscoveryFailure: (
    dispatchId: string,
    cause: Cause.Cause<Error | ProjectTeamRecoveryError>,
  ) => Effect.Effect<void, Error, Services>;
  readonly withClaim: <A, E, R>(
    discovered: ProjectTeamDispatchSnapshot,
    run: (claim: Claim) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | { readonly _tag: "Busy" }, Error | E, Services | R>;
  // Resume requires exact original operation identities, safe setup knowledge, physical Git/native
  // receipts and current gates. Root returns a freshly registered claim, never the discovered fence.
  readonly assess: (claim: Claim) => Effect.Effect<
    | {
        readonly _tag: "Resume";
        readonly claim: Claim;
        readonly snapshot: ProjectTeamDispatchSnapshot;
      }
    | { readonly _tag: "Cleanup"; readonly cause: Cause.Cause<Error | ProjectTeamRecoveryError> },
    Error,
    Services
  >;
  readonly resume: (claim: Claim) => Effect.Effect<ProjectTeamDispatchOutcome, Error, Services>;
  // Retained ownership survives revocation/deletion. Joined means every actual worker/setup writer
  // drained; Root validates the concrete receipt again when settling the durable reservation.
  readonly joinCleanup: (
    claim: Claim,
    cause: Cause.Cause<Error | ProjectTeamRecoveryError>,
  ) => Effect.Effect<
    | { readonly _tag: "Joined"; readonly receipt: Drain }
    | { readonly _tag: "Uncertain"; readonly cause: Cause.Cause<Error | ProjectTeamRecoveryError> },
    Error,
    Services
  >;
  readonly settle: (claim: Claim, receipt: Drain) => Effect.Effect<void, Error, Services>;
  readonly quarantine: (
    claim: Claim,
    cause: Cause.Cause<Error | ProjectTeamRecoveryError>,
  ) => Effect.Effect<void, Error, Services>;
}

/** One bounded page per sweep. The in-memory cursor orders discovery and never authorizes work. */
export function makeProjectTeamRecovery<
  Claim extends object,
  Drain extends object,
  Error,
  Services = never,
>(
  ports: ProjectTeamRecoveryPorts<Claim, Drain, Error, Services>,
  options: { readonly pageSize?: number } = {},
) {
  const pageSize = options.pageSize ?? 128;
  const serial = Semaphore.makeUnsafe(1);
  let afterDispatchId: string | undefined;
  type Outcome = ProjectTeamRecoveryOutcome<Error>;
  const reject = (reason: string) => new ProjectTeamRecoveryError({ reason });

  const cleanup = Effect.fn("ProjectTeamRecovery.cleanup")(function* (
    claim: Claim,
    initialCause: Cause.Cause<Error | ProjectTeamRecoveryError>,
  ): Effect.fn.Return<Outcome, Error | ProjectTeamRecoveryError, Services> {
    let cause = initialCause;
    const joined = yield* Effect.suspend(() => ports.joinCleanup(claim, cause)).pipe(Effect.exit);
    if (Exit.isSuccess(joined) && joined.value._tag === "Joined") {
      const receipt = joined.value.receipt;
      const settled = yield* Effect.suspend(() => ports.settle(claim, receipt)).pipe(Effect.exit);
      if (Exit.isSuccess(settled)) {
        if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
        return { _tag: "Settled", cause };
      }
      cause = Cause.combine(cause, settled.cause);
    } else {
      if (Exit.isFailure(joined)) cause = Cause.combine(cause, joined.cause);
      else if (joined.value._tag === "Uncertain") cause = Cause.combine(cause, joined.value.cause);
    }
    const recorded = yield* Effect.suspend(() => ports.quarantine(claim, cause)).pipe(Effect.exit);
    if (Exit.isFailure(recorded))
      return yield* Effect.failCause(Cause.combine(cause, recorded.cause));
    if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
    return { _tag: "Quarantined", cause };
  });

  const recover = Effect.fn("ProjectTeamRecovery.recover")(function* (
    discovered: ProjectTeamDispatchSnapshot,
  ) {
    return yield* ports.withClaim(discovered, (claim) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const assessed = yield* restore(Effect.suspend(() => ports.assess(claim))).pipe(
            Effect.exit,
          );
          if (Exit.isFailure(assessed)) return yield* cleanup(claim, assessed.cause);
          if (assessed.value._tag === "Cleanup") return yield* cleanup(claim, assessed.value.cause);
          const continuation = assessed.value;
          const fresh = continuation.snapshot;
          if (
            fresh.fence.dispatchId !== discovered.fence.dispatchId ||
            fresh.fence.claimGeneration <= 0
          ) {
            return yield* cleanup(
              claim,
              Cause.fail(reject("Root returned an invalid continuation claim")),
            );
          }
          const resumed = yield* restore(
            Effect.suspend(() => ports.resume(continuation.claim)),
          ).pipe(Effect.exit);
          if (Exit.isFailure(resumed)) return yield* cleanup(claim, resumed.cause);
          if (resumed.value._tag === "Busy") return { _tag: "Busy" as const };
          if (resumed.value._tag === "RecoveryRequired") {
            return yield* cleanup(
              claim,
              Cause.fail(reject("Dispatch requires further Root recovery")),
            );
          }
          if (resumed.value.fence.dispatchId !== fresh.fence.dispatchId) {
            return yield* cleanup(
              claim,
              Cause.fail(reject("Dispatch resumed a different identity")),
            );
          }
          return { _tag: "Resumed" as const, fence: resumed.value.fence };
        }),
      ),
    );
  });

  const sweep = Effect.fn("ProjectTeamRecovery.sweep")(function* () {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 128)
      return yield* reject("Recovery page size must be between 1 and 128");
    const page = yield* ports.readPage({
      ...(afterDispatchId === undefined ? {} : { afterDispatchId }),
      limit: pageSize,
    });
    let previous = afterDispatchId ?? "";
    if (page.length > pageSize) return yield* reject("Root exceeded the recovery page bound");
    for (const item of page) {
      if (!item.dispatchId || item.dispatchId <= previous)
        return yield* reject("Root recovery page is not strictly ordered");
      previous = item.dispatchId;
    }
    const items: {
      readonly dispatchId: string;
      readonly result: Exit.Exit<Outcome, Error | ProjectTeamRecoveryError>;
    }[] = [];
    for (const item of page) {
      const result = yield* Effect.scoped(
        Effect.suspend(() => {
          if (Exit.isFailure(item.snapshot)) {
            const cause = item.snapshot.cause;
            return Effect.suspend(() => ports.recordDiscoveryFailure(item.dispatchId, cause)).pipe(
              Effect.exit,
              Effect.flatMap((recorded) =>
                Effect.failCause(
                  Exit.isFailure(recorded) ? Cause.combine(cause, recorded.cause) : cause,
                ),
              ),
              Effect.uninterruptible,
            );
          }
          if (item.snapshot.value.fence.dispatchId !== item.dispatchId) {
            const cause = Cause.fail(reject("Root discovery identity does not match its snapshot"));
            return Effect.suspend(() => ports.recordDiscoveryFailure(item.dispatchId, cause)).pipe(
              Effect.exit,
              Effect.flatMap((recorded) =>
                Effect.failCause(
                  Exit.isFailure(recorded) ? Cause.combine(cause, recorded.cause) : cause,
                ),
              ),
              Effect.uninterruptible,
            );
          }
          return recover(item.snapshot.value);
        }),
      ).pipe(Effect.exit);
      if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
        return yield* Effect.failCause(result.cause);
      items.push({ dispatchId: item.dispatchId, result });
      afterDispatchId = item.dispatchId;
    }
    const wrapped = page.length < pageSize;
    if (wrapped) afterDispatchId = undefined;
    return { items, wrapped, ...(afterDispatchId === undefined ? {} : { afterDispatchId }) };
  }, serial.withPermit);
  return { sweep };
}
