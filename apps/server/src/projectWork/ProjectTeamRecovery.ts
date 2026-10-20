import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  ProjectTeamDispatchOutcome,
  ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatch.ts";

import type { ProjectTeamDispatchRecoveryPosition } from "./ProjectTeamDispatchJournal.ts";

/** The execution generation owns rolling continuations and receives completion wakes. */
export const ProjectTeamRecoveryExecution = Context.Reference<
  | {
      readonly scope: Scope.Scope;
      readonly completed: Effect.Effect<void>;
    }
  | undefined
>("ProjectTeamRecoveryExecution", { defaultValue: () => undefined });

const DispatchId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const isDispatchId = Schema.is(DispatchId);
const RecoveryPosition = Schema.Struct({
  rowId: Schema.String.check(
    Schema.isPattern(/^(?:0|-?[1-9][0-9]{0,18})$/),
    Schema.isMaxLength(20),
  ),
  dispatchIdHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodePosition = Schema.decodeUnknownEffect(RecoveryPosition, { onExcessProperty: "error" });

export class ProjectTeamRecoveryError extends Schema.TaggedError<ProjectTeamRecoveryError>()(
  "ProjectTeamRecoveryError",
  { reason: Schema.String },
) {}

export type ProjectTeamRecoveryDiscovery<Error> = {
  readonly dispatchId: string | null;
  readonly position?: ProjectTeamDispatchRecoveryPosition;
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
    readonly afterPosition?: ProjectTeamDispatchRecoveryPosition;
    readonly limit: number;
  }) => Effect.Effect<readonly ProjectTeamRecoveryDiscovery<Error>[], Error, Services>;
  readonly recordDiscoveryFailure: (
    dispatchId: string | null,
    cause: Cause.Cause<Error | ProjectTeamRecoveryError>,
    position?: ProjectTeamDispatchRecoveryPosition,
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
  const admission = Semaphore.makeUnsafe(1);
  type Cursor = {
    readonly dispatchId: string | null;
    readonly position?: ProjectTeamDispatchRecoveryPosition;
  };
  let cursor: Cursor | undefined;
  const running = new Set<string>();
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
    handoff: Effect.Effect<void> = Effect.void,
  ) {
    return yield* ports.withClaim(discovered, (claim) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const assessed = yield* restore(
            admission.withPermit(Effect.suspend(() => ports.assess(claim))),
          ).pipe(Effect.exit);
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
          yield* handoff;
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

  const discoveryFailure = Effect.fn("ProjectTeamRecovery.discoveryFailure")(function* (
    item: Cursor,
    cause: Cause.Cause<Error | ProjectTeamRecoveryError>,
  ) {
    const recorded = yield* Effect.suspend(() =>
      ports.recordDiscoveryFailure(item.dispatchId, cause, item.position),
    ).pipe(Effect.exit);
    // Join publication before observing cancellation; returning a decode failure alone masks it.
    const interrupted = yield* Effect.interruptible(Effect.void).pipe(Effect.exit);
    return yield* Effect.failCause(
      Cause.fromReasons([
        ...cause.reasons,
        ...(Exit.isFailure(recorded) ? recorded.cause.reasons : []),
        ...(Exit.isFailure(interrupted) ? interrupted.cause.reasons : []),
      ]),
    );
  }, Effect.uninterruptible);

  const sweep = Effect.fn("ProjectTeamRecovery.sweep")(function* () {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 128)
      return yield* reject("Recovery page size must be between 1 and 128");
    const read = yield* Effect.suspend(() =>
      ports.readPage({
        ...(cursor?.position !== undefined
          ? { afterPosition: cursor.position }
          : cursor?.dispatchId !== undefined && cursor.dispatchId !== null
            ? { afterDispatchId: cursor.dispatchId }
            : {}),
        limit: pageSize,
      }),
    ).pipe(Effect.exit);
    if (Exit.isFailure(read)) {
      if (cursor?.position !== undefined && !Cause.hasInterrupts(read.cause)) {
        // A deleted or changed SQL owner cannot pin discovery forever; the next sweep starts afresh.
        const failedCursor = cursor;
        cursor = undefined;
        return yield* discoveryFailure(failedCursor, read.cause);
      }
      return yield* Effect.failCause(read.cause);
    }
    const page = read.value;
    if (page.length > pageSize) return yield* reject("Root exceeded the recovery page bound");
    const positioned = page[0]?.position !== undefined;
    if (page.length > 0 && cursor !== undefined && positioned !== (cursor.position !== undefined))
      return yield* reject("Root recovery changed its continuation mode");
    let previous = cursor?.dispatchId ?? "";
    const rowIds = new Set<string>(cursor?.position === undefined ? [] : [cursor.position.rowId]);
    const validated: ProjectTeamRecoveryDiscovery<Error>[] = [];
    for (const item of page) {
      if ((item.position !== undefined) !== positioned)
        return yield* reject("Root mixed positioned and legacy discovery");
      if (item.position !== undefined) {
        const position = yield* decodePosition(item.position).pipe(
          Effect.mapError(() => reject("Root recovery position is invalid")),
        );
        if (rowIds.has(position.rowId)) return yield* reject("Root reused a recovery position");
        rowIds.add(position.rowId);
        // Positions are opaque: SQL owns raw key ordering, including normalized malformed keys.
        validated.push({
          ...item,
          dispatchId: Predicate.isString(item.dispatchId) ? item.dispatchId : null,
          position,
        });
      } else {
        if (!isDispatchId(item.dispatchId) || item.dispatchId <= previous)
          return yield* reject("Root recovery page is not strictly ordered");
        previous = item.dispatchId;
        validated.push(item);
      }
    }
    const execution = yield* ProjectTeamRecoveryExecution;
    const items = yield* Effect.forEach(
      validated,
      (item) =>
        Effect.gen(function* () {
          const ready =
            yield* Deferred.make<Exit.Exit<Outcome, Error | ProjectTeamRecoveryError>>();
          let resumed = false;
          const handoff = Effect.sync(() => {
            resumed = true;
            Deferred.doneUnsafe(ready, Effect.succeed(Exit.succeed({ _tag: "Busy" })));
          });
          const work = Effect.scoped(
            Effect.suspend(() => {
              if (Exit.isFailure(item.snapshot)) return discoveryFailure(item, item.snapshot.cause);
              if (!isDispatchId(item.dispatchId))
                return discoveryFailure(
                  item,
                  Cause.fail(reject("Root discovery dispatch identity is invalid")),
                );
              if (item.snapshot.value.fence.dispatchId !== item.dispatchId)
                return discoveryFailure(
                  item,
                  Cause.fail(reject("Root discovery identity does not match its snapshot")),
                );
              return recover(item.snapshot.value, execution === undefined ? Effect.void : handoff);
            }),
          );
          const result = yield* Effect.gen(function* () {
            if (execution === undefined || !isDispatchId(item.dispatchId))
              return yield* work.pipe(Effect.exit);
            const dispatchId = item.dispatchId;
            if (running.has(dispatchId) || running.size >= pageSize)
              return Exit.succeed({ _tag: "Busy" as const });
            // Register before forking. Scope owns interruption and joins; the claim stays inside work.
            return yield* Effect.uninterruptibleMask(function (restore) {
              return Effect.gen(function* () {
                running.add(dispatchId);
                yield* Effect.forkIn(
                  restore(work).pipe(
                    Effect.exit,
                    Effect.flatMap((result) =>
                      Effect.gen(function* () {
                        running.delete(dispatchId);
                        yield* Deferred.succeed(ready, result);
                        if (resumed) yield* execution.completed;
                      }),
                    ),
                  ),
                  execution.scope,
                );
                return yield* restore(Deferred.await(ready));
              });
            });
          });
          if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
            return yield* Effect.failCause(result.cause);
          return { dispatchId: item.dispatchId, result };
        }),
      { concurrency: pageSize },
    );
    // Advance after bounded discovery hands off ownership. Live claims remain in the generation scope.
    const last = validated.at(-1);
    if (last !== undefined)
      cursor = {
        dispatchId: last.dispatchId,
        ...(last.position === undefined ? {} : { position: last.position }),
      };
    const wrapped = page.length < pageSize;
    if (wrapped) cursor = undefined;
    return {
      items,
      wrapped,
      ...(cursor?.position !== undefined
        ? { afterPosition: cursor.position }
        : cursor?.dispatchId !== undefined && cursor.dispatchId !== null
          ? { afterDispatchId: cursor.dispatchId }
          : {}),
    };
  }, serial.withPermit);
  return { sweep };
}
