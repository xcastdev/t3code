import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchFence,
  ProjectTeamWorkspaceReceipt,
} from "./ProjectTeamDispatchJournal.ts";

type Journal = Effect.Success<ReturnType<typeof makeProjectTeamDispatchJournal>>;
export type ProjectTeamDispatchSnapshot = Effect.Success<ReturnType<Journal["inspect"]>>;
type Workspace = typeof ProjectTeamWorkspaceReceipt.Type;

export type ProjectTeamDispatchReceipt<Setup, Session, Assignment> =
  | { readonly stage: "workspace-ready"; readonly workspace: Workspace }
  | { readonly stage: "setup-complete"; readonly workspace: Workspace; readonly setup: Setup }
  | {
      readonly stage: "session-bound" | "assignment-intent";
      readonly workspace: Workspace;
      readonly setup: Setup;
      readonly session: Session;
    }
  | {
      readonly stage: "assignment-observed";
      readonly workspace: Workspace;
      readonly setup: Setup;
      readonly session: Session;
      readonly assignment: Assignment;
    };

export type ProjectTeamDispatchOutcome =
  | { readonly _tag: "Busy" }
  | { readonly _tag: "RecoveryRequired"; readonly dispatchId: string }
  | { readonly _tag: "Observed"; readonly fence: ProjectTeamDispatchFence };

export class ProjectTeamDispatchError extends Schema.TaggedError<ProjectTeamDispatchError>()(
  "ProjectTeamDispatchError",
  { reason: Schema.String },
) {}

/** Root validates registered executor/recovery objects and concrete receipts at its durable boundary. */
export interface ProjectTeamDispatchPorts<
  Owner extends object,
  RecoveryClaim extends object,
  Setup,
  Session,
  Assignment,
  Error,
  Services = never,
> {
  readonly withExecutor: <A, E, R>(
    dispatchId: string,
    run: (owner: Owner) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | { readonly _tag: "Busy" }, Error | E, Services | R>;
  readonly withRecoveryExecutor: <A, E, R>(
    claim: RecoveryClaim,
    run: (owner: Owner, snapshot: ProjectTeamDispatchSnapshot) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | { readonly _tag: "Busy" }, Error | E, Services | R>;
  readonly inspect: (
    dispatchId: string,
  ) => Effect.Effect<ProjectTeamDispatchSnapshot, Error, Services>;
  readonly claimEffect: (
    owner: Owner,
    expected: ProjectTeamDispatchFence,
  ) => Effect.Effect<ProjectTeamDispatchSnapshot, Error, Services>;
  readonly assertCurrent: (
    owner: Owner,
    expected: ProjectTeamDispatchFence,
  ) => Effect.Effect<ProjectTeamDispatchSnapshot, Error, Services>;
  readonly readReceipt: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
  ) => Effect.Effect<
    ProjectTeamDispatchReceipt<Setup, Session, Assignment> | undefined,
    Error,
    Services
  >;
  readonly appendStage: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    receipt: ProjectTeamDispatchReceipt<Setup, Session, Assignment>,
  ) => Effect.Effect<ProjectTeamDispatchSnapshot, Error, Services>;
  readonly workspace: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
  ) => Effect.Effect<Workspace, Error, Services>;
  readonly setup: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    workspace: Workspace,
  ) => Effect.Effect<Setup, Error, Services>;
  readonly initialize: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    workspace: Workspace,
    setup: Setup,
  ) => Effect.Effect<Session, Error, Services>;
  readonly sendAssignment: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    session: Session,
  ) => Effect.Effect<
    | { readonly _tag: "Observed"; readonly receipt: Assignment }
    | { readonly _tag: "Uncertain"; readonly cause: Cause.Cause<Error> },
    Error,
    Services
  >;
  readonly readAssignmentObservation: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    session: Session,
  ) => Effect.Effect<Assignment | undefined, Error, Services>;
  // These use retained cleanup ownership, including after cancellation or authority loss.
  readonly recordUncertain: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    cause: Cause.Cause<Error | ProjectTeamDispatchError>,
  ) => Effect.Effect<void, Error, Services>;
  readonly stopAndJoin: (
    owner: Owner,
    snapshot: ProjectTeamDispatchSnapshot,
    cause: Cause.Cause<Error | ProjectTeamDispatchError>,
  ) => Effect.Effect<void, Error, Services>;
}

const rejected = (reason: string) => new ProjectTeamDispatchError({ reason });
const sameFence = (left: ProjectTeamDispatchFence, right: ProjectTeamDispatchFence) =>
  left.dispatchId === right.dispatchId &&
  left.revision === right.revision &&
  left.claimGeneration === right.claimGeneration &&
  left.stage === right.stage;

/** Drives one admitted dispatch. It neither creates authority nor retries uncertain external work. */
export function makeProjectTeamDispatch<
  Owner extends object,
  RecoveryClaim extends object,
  Setup,
  Session,
  Assignment,
  Error,
  Services = never,
>(
  ports: ProjectTeamDispatchPorts<
    Owner,
    RecoveryClaim,
    Setup,
    Session,
    Assignment,
    Error,
    Services
  >,
) {
  type Receipt = ProjectTeamDispatchReceipt<Setup, Session, Assignment>;
  const drive = Effect.fn("ProjectTeamDispatch.drive")(function* (
    owner: Owner,
    initial: ProjectTeamDispatchSnapshot,
  ): Effect.fn.Return<ProjectTeamDispatchOutcome, Error | ProjectTeamDispatchError, Services> {
    let snapshot = initial;
    let assignmentMayHaveBeenSent = snapshot.fence.stage === "assignment-intent";
    let assignmentObserved = snapshot.fence.stage === "assignment-observed";
    const current = Effect.fn("ProjectTeamDispatch.current")(function* () {
      const checked = yield* ports.assertCurrent(owner, snapshot.fence);
      if (!sameFence(checked.fence, snapshot.fence))
        return yield* rejected("Root returned a different dispatch fence");
    });
    const append = Effect.fn("ProjectTeamDispatch.append")(function* (receipt: Receipt) {
      yield* current();
      const committed = yield* ports.appendStage(owner, snapshot, receipt);
      if (
        committed.fence.dispatchId !== snapshot.fence.dispatchId ||
        committed.fence.claimGeneration !== snapshot.fence.claimGeneration ||
        committed.fence.revision !== snapshot.fence.revision + 1 ||
        committed.fence.stage !== receipt.stage
      )
        return yield* rejected("Root returned an invalid stage receipt fence");
      snapshot = committed;
      yield* current();
    });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* restore(
          Effect.gen(function* () {
            yield* current();
            let receipt: Receipt | undefined;
            if (snapshot.fence.stage !== "reserved") {
              receipt = yield* ports.readReceipt(owner, snapshot);
              yield* current();
              if (!receipt || receipt.stage !== snapshot.fence.stage)
                return yield* rejected("Exact durable stage receipt is unavailable");
            }
            if (snapshot.fence.stage === "reserved") {
              yield* current();
              const workspace = yield* ports.workspace(owner, snapshot);
              yield* current();
              receipt = { stage: "workspace-ready", workspace };
              yield* append(receipt);
            }
            if (receipt?.stage === "workspace-ready") {
              yield* current();
              const setup = yield* ports.setup(owner, snapshot, receipt.workspace);
              yield* current();
              receipt = { stage: "setup-complete", workspace: receipt.workspace, setup };
              yield* append(receipt);
            }
            if (receipt?.stage === "setup-complete") {
              yield* current();
              const session = yield* ports.initialize(
                owner,
                snapshot,
                receipt.workspace,
                receipt.setup,
              );
              yield* current();
              receipt = { ...receipt, stage: "session-bound", session };
              yield* append(receipt);
            }
            if (receipt?.stage === "session-bound") {
              receipt = { ...receipt, stage: "assignment-intent" };
              yield* append(receipt);
              yield* current();
              // No SDK prompt idempotence is assumed. Every failure after entry retains uncertainty.
              assignmentMayHaveBeenSent = true;
              const outcome = yield* ports.sendAssignment(owner, snapshot, receipt.session);
              if (outcome._tag === "Uncertain") return yield* Effect.failCause(outcome.cause);
              assignmentObserved = true;
              yield* current();
              receipt = { ...receipt, stage: "assignment-observed", assignment: outcome.receipt };
              yield* append(receipt);
            } else if (receipt?.stage === "assignment-intent") {
              yield* current();
              const observation = yield* ports.readAssignmentObservation(
                owner,
                snapshot,
                receipt.session,
              );
              yield* current();
              if (observation === undefined)
                return yield* rejected(
                  "Assignment delivery has no exact native observation; resend is forbidden",
                );
              assignmentObserved = true;
              receipt = { ...receipt, stage: "assignment-observed", assignment: observation };
              yield* append(receipt);
            }
            if (receipt?.stage !== "assignment-observed")
              return yield* rejected("Dispatch stage requires Root recovery");
            yield* current();
            return { _tag: "Observed" as const, fence: snapshot.fence };
          }),
        ).pipe(Effect.exit);
        if (Exit.isSuccess(result)) return result.value;
        let cause = result.cause;
        if (assignmentMayHaveBeenSent && !assignmentObserved) {
          const recorded = yield* Effect.suspend(() =>
            ports.recordUncertain(owner, snapshot, cause),
          ).pipe(Effect.exit);
          if (Exit.isFailure(recorded)) cause = Cause.combine(cause, recorded.cause);
        }
        const cleanup = yield* Effect.suspend(() => ports.stopAndJoin(owner, snapshot, cause)).pipe(
          Effect.exit,
        );
        if (Exit.isFailure(cleanup)) cause = Cause.combine(cause, cleanup.cause);
        return yield* Effect.failCause(cause);
      }),
    );
  });
  const dispatch = Effect.fn("ProjectTeamDispatch.dispatch")(function* (dispatchId: string) {
    return yield* ports.withExecutor(dispatchId, (owner) =>
      Effect.gen(function* () {
        const snapshot = yield* ports.inspect(dispatchId);
        if (snapshot.fence.stage !== "reserved" || snapshot.fence.claimGeneration !== 0)
          return { _tag: "RecoveryRequired" as const, dispatchId };
        const checked = yield* ports.assertCurrent(owner, snapshot.fence);
        if (!sameFence(checked.fence, snapshot.fence))
          return yield* rejected("Initial dispatch fence changed");
        const claimed = yield* ports.claimEffect(owner, snapshot.fence);
        if (
          claimed.fence.dispatchId !== dispatchId ||
          claimed.fence.stage !== "reserved" ||
          claimed.fence.revision !== snapshot.fence.revision + 1 ||
          claimed.fence.claimGeneration !== snapshot.fence.claimGeneration + 1
        )
          return yield* rejected("Root returned an invalid dispatch claim");
        return yield* drive(owner, claimed);
      }),
    );
  });
  const resume = Effect.fn("ProjectTeamDispatch.resume")(function* (claim: RecoveryClaim) {
    return yield* ports.withRecoveryExecutor(claim, (owner, snapshot) =>
      Effect.gen(function* () {
        const checked = yield* ports.assertCurrent(owner, snapshot.fence);
        if (!sameFence(checked.fence, snapshot.fence) || snapshot.fence.claimGeneration <= 0)
          return yield* rejected("Root recovery claim has no current claimed dispatch");
        return yield* drive(owner, snapshot);
      }),
    );
  });
  return { dispatch, resume };
}
