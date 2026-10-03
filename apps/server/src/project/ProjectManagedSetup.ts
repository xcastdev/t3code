import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  PiManagedProcessError,
  type PiManagedDrain,
  type PiManagedLaunch,
  type PiManagedProcess,
  type PiManagedProcessAllocation,
  type PiManagedProcessOwner,
  type PiManagedProcessPersistence,
  type PiManagedProcessReconciliation,
  type PiManagedProcessRecovery,
} from "../provider/pi/PiManagedProcess.ts";
import {
  collectUint8StreamText,
  type CollectedUint8StreamText,
} from "../stream/collectUint8StreamText.ts";

export interface ProjectManagedSetupInput {
  readonly setupId: string;
  readonly dispatchId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly worktreePath: string;
  readonly deadlineAtMs: number;
}

export type ProjectManagedSetupSelection =
  | { readonly kind: "none" }
  | {
      readonly kind: "script";
      readonly scriptId: string;
      readonly scriptRevision: string;
      readonly cwd: string;
      readonly launch: PiManagedLaunch;
    };

export interface ProjectManagedSetupReceipt {
  readonly outcome: "skipped" | "succeeded" | "failed" | "canceled";
  readonly selection: ProjectManagedSetupSelection;
  readonly allocation: PiManagedProcessAllocation | null;
  readonly owner: PiManagedProcessOwner | null;
  readonly drain: PiManagedDrain | null;
  readonly reconciliation: PiManagedProcessReconciliation | null;
  readonly stdout: CollectedUint8StreamText | null;
  readonly stderr: CollectedUint8StreamText | null;
  readonly reason: string | null;
}

export interface ProjectManagedSetupRetained {
  readonly selection: ProjectManagedSetupSelection;
  readonly allocation: PiManagedProcessAllocation | null;
  readonly activation: "unlaunched" | "claimed" | "owned";
  readonly owner: PiManagedProcessOwner | null;
  readonly receipt: ProjectManagedSetupReceipt | null;
  readonly uncertain: boolean;
}

export class ProjectManagedSetupError extends Schema.TaggedError<ProjectManagedSetupError>()(
  "ProjectManagedSetupError",
  { reason: Schema.String },
) {}

// Only private parent composition may implement these ports. Each write binds the entire
// input tuple; retaining a record is not permission to execute a stale assignment.
export interface ProjectManagedSetupPorts<R = never> {
  readonly read: (
    input: ProjectManagedSetupInput,
  ) => Effect.Effect<ProjectManagedSetupRetained | null, ProjectManagedSetupError, R>;
  readonly resolveSelection: (
    input: ProjectManagedSetupInput,
  ) => Effect.Effect<ProjectManagedSetupSelection, ProjectManagedSetupError, R>;
  readonly validateCurrent: (
    input: ProjectManagedSetupInput,
    selection: ProjectManagedSetupSelection | null,
    phase: "selection" | "allocation" | "activation" | "start" | "completion",
  ) => Effect.Effect<void, ProjectManagedSetupError, R>;
  // Both freeze operations return the committed winner, including any existing allocation.
  readonly freezeSelection: (
    input: ProjectManagedSetupInput,
    selection: ProjectManagedSetupSelection,
  ) => Effect.Effect<ProjectManagedSetupRetained, ProjectManagedSetupError, R>;
  readonly freezeAllocation: (
    input: ProjectManagedSetupInput,
    selection: ProjectManagedSetupSelection,
    allocation: PiManagedProcessAllocation,
  ) => Effect.Effect<ProjectManagedSetupRetained, ProjectManagedSetupError, R>;
  readonly claimActivation: (
    input: ProjectManagedSetupInput,
    selection: ProjectManagedSetupSelection,
    allocation: PiManagedProcessAllocation,
  ) => Effect.Effect<"claimed" | "already-claimed", PiManagedProcessError, R>;
  readonly persistOwner: (
    input: ProjectManagedSetupInput,
    allocation: PiManagedProcessAllocation,
    owner: PiManagedProcessOwner,
  ) => Effect.Effect<void, PiManagedProcessError, R>;
  readonly persistStarted: (
    input: ProjectManagedSetupInput,
    allocation: PiManagedProcessAllocation,
    owner: PiManagedProcessOwner,
    childPid: number,
  ) => Effect.Effect<void, ProjectManagedSetupError, R>;
  // Failed/canceled receipts persist physical drain even after authority is revoked.
  readonly persistReceipt: (
    input: ProjectManagedSetupInput,
    receipt: ProjectManagedSetupReceipt,
  ) => Effect.Effect<void, ProjectManagedSetupError, R>;
  // This write holds/quarantines retained ownership; it never clears a reservation.
  readonly markUncertain: (
    input: ProjectManagedSetupInput,
    retained: {
      readonly selection: ProjectManagedSetupSelection | null;
      readonly allocation: PiManagedProcessAllocation | null;
      readonly owner: PiManagedProcessOwner | null;
      readonly drain: PiManagedDrain | null;
      readonly reconciliation: PiManagedProcessReconciliation | null;
      readonly reason: string;
    },
  ) => Effect.Effect<void, ProjectManagedSetupError, R>;
  readonly preallocate: (
    launch: PiManagedLaunch,
  ) => Effect.Effect<PiManagedProcessAllocation, PiManagedProcessError, R>;
  readonly acquire: (
    launch: PiManagedLaunch,
    persistence: PiManagedProcessPersistence,
  ) => Effect.Effect<PiManagedProcess, PiManagedProcessError, R | Scope.Scope>;
  readonly reconcileProcess: (
    recovery: PiManagedProcessRecovery,
    options: { readonly stop: boolean },
  ) => Effect.Effect<PiManagedProcessReconciliation, PiManagedProcessError, R>;
}

const failure = (reason: string) => new ProjectManagedSetupError({ reason });
const OUTPUT_BYTES = 32768;
const CLEANUP_MS = 5000;

/** Owns setup lifecycle ordering; durable authority, script resolution and native launch stay in Root. */
export const makeProjectManagedSetup = <R>(ports: ProjectManagedSetupPorts<R>) => {
  const run = Effect.fn("ProjectManagedSetup.run")(function* (
    original: ProjectManagedSetupInput,
    recovering: boolean,
  ) {
    // A caller cannot extend the deadline or replace the assignment while this Effect yields.
    const input = Object.freeze({ ...original });
    const context = yield* Effect.context<R>();
    let retained: ProjectManagedSetupRetained | null = null;
    let drain: PiManagedDrain | null = null;
    let reconciliation: PiManagedProcessReconciliation | null = null;
    let duplicate = false;
    const current = Effect.fn("ProjectManagedSetup.current")(function* (
      selection: ProjectManagedSetupSelection | null,
      phase: Parameters<ProjectManagedSetupPorts<R>["validateCurrent"]>[2],
    ) {
      yield* ports.validateCurrent(input, selection, phase);
      // Sample after the authority/workspace/script reads, never before their receipts.
      if (
        !Number.isSafeInteger(input.deadlineAtMs) ||
        input.deadlineAtMs <= (yield* Clock.currentTimeMillis)
      )
        return yield* Effect.fail(failure("deadline expired"));
      if (
        selection?.kind === "script" &&
        (selection.cwd !== input.worktreePath ||
          selection.launch.workspaceRoot !== input.worktreePath ||
          selection.launch.workspaceAccess !== "readwrite")
      )
        return yield* Effect.fail(
          failure("setup selection does not match the writable assigned workspace"),
        );
    });
    const persist = Effect.fn("ProjectManagedSetup.persist")(function* (
      receipt: ProjectManagedSetupReceipt,
    ) {
      yield* ports.persistReceipt(input, receipt);
      return receipt;
    });
    const receipt = (selection: ProjectManagedSetupSelection): ProjectManagedSetupReceipt => ({
      outcome: "failed",
      selection,
      allocation: retained?.allocation ?? null,
      owner: retained?.owner ?? null,
      drain,
      reconciliation,
      stdout: null,
      stderr: null,
      reason: null,
    });

    const work = Effect.scoped(
      Effect.gen(function* () {
        retained = yield* ports.read(input);
        if (retained?.receipt && !retained.uncertain) {
          yield* current(retained.selection, "completion");
          return retained.receipt;
        }
        if (recovering)
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (!retained?.allocation)
                return yield* Effect.fail(failure("no retained setup allocation to reconcile"));
              reconciliation = yield* ports.reconcileProcess(
                {
                  allocation: retained.allocation,
                  activation: retained.activation,
                  ...(retained.owner ? { owner: retained.owner } : {}),
                },
                { stop: true },
              );
              if (reconciliation.state === "owned")
                return yield* Effect.fail(failure("setup drain remains unproved"));
              // A stopped service does not recover a lost script exit or lost pipe receipt.
              return yield* persist({
                ...receipt(retained.selection),
                reason: "setup exit or joined output was not retained; script was not repeated",
              });
            }),
          );
        if (retained && (retained.uncertain || retained.activation !== "unlaunched")) {
          duplicate = true;
          return yield* Effect.fail(failure("reconciliation required"));
        }
        yield* current(retained?.selection ?? null, "selection");
        if (!retained) {
          const selected = yield* ports.resolveSelection(input);
          yield* current(selected, "allocation");
          retained = yield* ports.freezeSelection(input, structuredClone(selected));
        }
        if (retained.uncertain || retained.activation !== "unlaunched") {
          duplicate = true;
          return yield* Effect.fail(failure("reconciliation required"));
        }
        if (retained.receipt) {
          yield* current(retained.selection, "completion");
          return retained.receipt;
        }
        const selection = structuredClone(retained.selection);
        yield* current(selection, "allocation");
        if (selection.kind === "none") {
          yield* current(selection, "completion");
          return yield* persist({ ...receipt(selection), outcome: "skipped" });
        }
        if (!retained.allocation) {
          const allocated = yield* ports.preallocate(selection.launch);
          yield* current(selection, "allocation");
          retained = yield* ports.freezeAllocation(input, selection, allocated);
        }
        if (retained.uncertain || retained.activation !== "unlaunched" || retained.receipt) {
          duplicate = true;
          return yield* Effect.fail(failure("reconciliation required"));
        }
        const allocation = retained.allocation;
        if (!allocation) return yield* Effect.fail(failure("setup allocation was not retained"));
        // Root's freeze port must preserve the selection winner. Recheck its returned selection.
        yield* current(retained.selection, "activation");
        if (
          retained.selection.kind !== "script" ||
          retained.selection.scriptId !== selection.scriptId ||
          retained.selection.scriptRevision !== selection.scriptRevision ||
          retained.selection.cwd !== selection.cwd
        )
          return yield* Effect.fail(failure("frozen setup selection changed"));

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const process = yield* restore(
              ports.acquire(selection.launch, {
                allocation,
                claimActivation: (actual) =>
                  Effect.gen(function* () {
                    yield* current(selection, "activation").pipe(
                      Effect.mapError(
                        () =>
                          new PiManagedProcessError({
                            phase: "validation",
                            message: "setup activation authority is stale",
                          }),
                      ),
                    );
                    const claimed = yield* ports.claimActivation(input, selection, actual);
                    if (claimed === "already-claimed") {
                      duplicate = true;
                      return yield* Effect.fail(
                        new PiManagedProcessError({
                          phase: "startup",
                          message: "setup activation was already claimed",
                        }),
                      );
                    }
                    retained = { ...retained!, activation: "claimed" };
                  }).pipe(Effect.provideContext(context)),
                beforeStart: (owner) =>
                  Effect.gen(function* () {
                    // Capture actual ownership before any authority read that could reject it.
                    retained = { ...retained!, owner, activation: "owned" };
                    yield* ports.persistOwner(input, allocation, owner);
                    yield* current(selection, "start").pipe(
                      Effect.mapError(
                        () =>
                          new PiManagedProcessError({
                            phase: "validation",
                            message: "setup start authority is stale",
                          }),
                      ),
                    );
                  }).pipe(Effect.provideContext(context)),
              }),
            );
            const stdout = yield* collectUint8StreamText({
              stream: process.stdout,
              maxBytes: OUTPUT_BYTES,
            }).pipe(Effect.interruptible, Effect.forkScoped);
            const stderr = yield* collectUint8StreamText({
              stream: process.stderr,
              maxBytes: OUTPUT_BYTES,
            }).pipe(Effect.interruptible, Effect.forkScoped);
            const remaining = input.deadlineAtMs - (yield* Clock.currentTimeMillis);
            const execution = yield* restore(
              Effect.gen(function* () {
                yield* current(selection, "start");
                const childPid = yield* process.start;
                if (!Number.isSafeInteger(childPid) || childPid < 1 || childPid > 2147483647)
                  return yield* failure("managed setup returned an invalid native start receipt");
                yield* ports.persistStarted(input, allocation, process.owner, childPid);
                return yield* process.awaitExit;
              }).pipe(Effect.timeout(Math.max(1, remaining))),
            ).pipe(Effect.exit);
            const stopped =
              execution._tag === "Success" ? execution : yield* process.stop.pipe(Effect.exit);
            if (stopped._tag === "Failure") {
              // Scoped output readers are interrupted/joined even when native drain is uncertain.
              yield* Fiber.interrupt(stdout);
              yield* Fiber.interrupt(stderr);
              return yield* Effect.failCause(
                execution._tag === "Failure"
                  ? Cause.combine(execution.cause, stopped.cause)
                  : stopped.cause,
              );
            }
            drain = stopped.value;
            const outputs = yield* Effect.all([Fiber.join(stdout), Fiber.join(stderr)], {
              concurrency: "unbounded",
            }).pipe(Effect.timeout(CLEANUP_MS), Effect.exit);
            if (outputs._tag === "Failure") {
              yield* Fiber.interrupt(stdout);
              yield* Fiber.interrupt(stderr);
              return yield* Effect.failCause(
                execution._tag === "Failure"
                  ? Cause.combine(execution.cause, outputs.cause)
                  : outputs.cause,
              );
            }
            const authority = yield* restore(current(selection, "completion")).pipe(Effect.exit);
            const canceled =
              (execution._tag === "Failure" &&
                execution.cause.reasons.some(Cause.isInterruptReason)) ||
              (authority._tag === "Failure" &&
                authority.cause.reasons.some(Cause.isInterruptReason));
            const published = yield* persist({
              ...receipt(selection),
              stdout: outputs.value[0]!,
              stderr: outputs.value[1]!,
              outcome:
                canceled || authority._tag === "Failure"
                  ? "canceled"
                  : execution._tag === "Success" && drain.childExitCode === 0
                    ? "succeeded"
                    : "failed",
              reason:
                authority._tag === "Failure"
                  ? "setup authority was revoked before completion"
                  : execution._tag === "Failure"
                    ? "setup execution did not complete"
                    : drain.childExitCode === 0
                      ? null
                      : "setup script failed or has no retained exit",
            }).pipe(Effect.exit);
            if (published._tag === "Failure")
              return yield* Effect.failCause(
                Cause.combine(
                  published.cause,
                  Cause.combine(
                    execution._tag === "Failure" ? execution.cause : Cause.empty,
                    authority._tag === "Failure" ? authority.cause : Cause.empty,
                  ),
                ),
              );
            if (execution._tag === "Failure") return yield* Effect.failCause(execution.cause);
            if (canceled && authority._tag === "Failure")
              return yield* Effect.failCause(authority.cause);
            return published.value;
          }),
        );
      }),
    );
    const remainingMs = input.deadlineAtMs - (yield* Clock.currentTimeMillis);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* restore(
          recovering
            ? work
            : work.pipe(
                Effect.timeout(Number.isSafeInteger(remainingMs) ? Math.max(1, remainingMs) : 1),
              ),
        ).pipe(Effect.exit);
        if (result._tag === "Success") return result.value;
        const cause = result.cause;
        if (duplicate) return yield* Effect.failCause(cause);
        const held = yield* ports
          .markUncertain(input, {
            selection: retained?.selection ?? null,
            allocation: retained?.allocation ?? null,
            owner: retained?.owner ?? null,
            drain,
            reconciliation,
            reason: "setup execution, receipt or cleanup was not proved",
          })
          .pipe(Effect.exit);
        return yield* Effect.failCause(
          held._tag === "Failure" ? Cause.combine(cause, held.cause) : cause,
        );
      }),
    );
  });
  const execute = (input: ProjectManagedSetupInput) => run(Object.freeze({ ...input }), false);
  const reconcile = (input: ProjectManagedSetupInput) => run(Object.freeze({ ...input }), true);
  return { execute, reconcile };
};
