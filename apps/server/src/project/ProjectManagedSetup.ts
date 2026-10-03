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
      // Root atomically compares this entire snapshot, including selection, before writing.
      // A captured owner may recover a lost persistOwner response only if its exact identity matches.
      readonly expected: Omit<ProjectManagedSetupRetained, "uncertain"> | null;
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

// These retained descriptors contain plain data. Compare every frozen field, including launch
// bytes and native filesystem identities, rather than accepting a matching script ID alone.
const same = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, index: number) => same(value, right[index]))
    );
  const entries = Object.entries(left).filter(([, value]) => value !== undefined);
  return (
    entries.length === Object.entries(right).filter(([, value]) => value !== undefined).length &&
    entries.every(
      ([key, value]) => Object.hasOwn(right, key) && same(value, Reflect.get(right, key)),
    )
  );
};
const pid = (value: number | null) =>
  value !== null && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const physicallyDrained = (kernel: string) => {
  if (kernel === "removed") return true;
  if (kernel.length > 4096) return false;
  const populated = kernel.split("\n").filter((line) => /^populated(?:\s|$)/.test(line));
  return populated.length === 1 && populated[0] === "populated 0";
};
const boundedOutput = (output: CollectedUint8StreamText | null) => {
  if (
    !output ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 0 ||
    output.bytes > OUTPUT_BYTES ||
    (output.truncated && output.bytes !== OUTPUT_BYTES) ||
    output.text.length > OUTPUT_BYTES * 3
  )
    return false;
  const encodedBytes = new TextEncoder().encode(output.text).byteLength;
  return output.invalidUtf8 ? encodedBytes <= output.bytes * 3 : encodedBytes === output.bytes;
};
const validReceipt = (retained: ProjectManagedSetupRetained): boolean => {
  const receipt = retained.receipt;
  if (
    !receipt ||
    !same(receipt.selection, retained.selection) ||
    !same(receipt.allocation, retained.allocation) ||
    !same(receipt.owner, retained.owner)
  )
    return false;
  if (receipt.outcome === "skipped")
    return (
      retained.selection.kind === "none" &&
      retained.activation === "unlaunched" &&
      !receipt.allocation &&
      !receipt.owner &&
      !receipt.drain &&
      !receipt.reconciliation &&
      !receipt.stdout &&
      !receipt.stderr &&
      receipt.reason === null
    );
  const { allocation, owner, drain, reconciliation } = receipt;
  if (retained.selection.kind !== "script" || !allocation) return false;
  // Native allocation resolves runtime sources and protected roots to physical paths.
  // Their complete pinned identities were compared to retained allocation above.
  const selected = retained.selection.launch;
  if (
    allocation.launch.workspace.path !== retained.selection.cwd ||
    allocation.launch.workspaceRoot !== selected.workspaceRoot ||
    allocation.launch.workspaceAccess !== selected.workspaceAccess ||
    !same(allocation.launch.argv, selected.argv) ||
    !same(
      allocation.launch.runtimeFiles.map((file) => file.target),
      selected.runtimeFiles.map((file) => file.target),
    ) ||
    allocation.policy.memoryBytes !== selected.memoryBytes ||
    allocation.policy.runtimeSeconds !== selected.runtimeSeconds
  )
    return false;
  if (
    owner &&
    (retained.activation !== "owned" ||
      !pid(owner.pid) ||
      owner.unit !== allocation.unit ||
      owner.nonce !== allocation.nonce ||
      owner.memoryBytes !== allocation.policy.memoryBytes ||
      owner.swapBytes !== 0 ||
      owner.oomGroup !== 1 ||
      !/^[a-f0-9]{32}$/.test(owner.invocation) ||
      !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
      !owner.cgroup.endsWith(`/${allocation.unit}`) ||
      owner.cgroup.split("/").some((part) => part === "." || part === ".."))
  )
    return false;
  if (
    drain &&
    (!owner ||
      drain.unit !== owner.unit ||
      drain.invocation !== owner.invocation ||
      drain.cgroup !== owner.cgroup ||
      drain.ownerPid !== owner.pid ||
      drain.memoryBytes !== owner.memoryBytes ||
      drain.swapBytes !== owner.swapBytes ||
      drain.oomGroup !== owner.oomGroup ||
      !pid(drain.launcherPid) ||
      (drain.childPid !== null && !pid(drain.childPid)) ||
      (drain.childExitCode !== null && !Number.isSafeInteger(drain.childExitCode)) ||
      !physicallyDrained(drain.kernel))
  )
    return false;
  if (
    reconciliation &&
    (drain ||
      reconciliation.unit !== allocation.unit ||
      (owner
        ? reconciliation.state !== "drained" ||
          reconciliation.invocation !== owner.invocation ||
          reconciliation.cgroup !== owner.cgroup ||
          !physicallyDrained(reconciliation.kernel)
        : retained.activation !== "unlaunched" ||
          reconciliation.state !== "absent" ||
          reconciliation.invocation !== null ||
          reconciliation.cgroup !== null ||
          reconciliation.kernel !== "not-created"))
  )
    return false;
  if (receipt.outcome === "succeeded")
    return (
      !!owner &&
      !!drain &&
      pid(drain.childPid) &&
      drain.childExitCode === 0 &&
      !reconciliation &&
      boundedOutput(receipt.stdout) &&
      boundedOutput(receipt.stderr) &&
      receipt.reason === null
    );
  // Recovery can prove cleanup without recovering the script exit or its joined pipes.
  return (
    receipt.reason !== null &&
    (!!drain || !!reconciliation) &&
    ((!receipt.stdout && !receipt.stderr) ||
      (boundedOutput(receipt.stdout) && boundedOutput(receipt.stderr)))
  );
};

/** The durable parent validates the same complete receipt before accepting or replaying it. */
export const isProjectManagedSetupReceiptValid = validReceipt;

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
    let markRequired = false;
    let expected: Omit<ProjectManagedSetupRetained, "uncertain"> | null = null;
    const remember = (value: ProjectManagedSetupRetained | null) => {
      if (!value) return null;
      const { uncertain: _uncertain, ...snapshot } = value;
      return structuredClone(snapshot);
    };
    const replay = Effect.fn("ProjectManagedSetup.replay")(function* (
      value: ProjectManagedSetupRetained,
    ) {
      if (!validReceipt(value)) {
        markRequired = true;
        return yield* Effect.fail(
          failure("retained setup receipt contradicts frozen ownership or cleanup"),
        );
      }
      yield* current(value.selection, "completion");
      return value.receipt!;
    });
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
      markRequired = true;
      yield* ports.persistReceipt(input, receipt);
      if (retained) {
        retained = { ...retained, receipt };
        expected = remember(retained);
      }
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
        expected = remember(retained);
        if (retained?.receipt && !retained.uncertain) {
          return yield* replay(retained);
        }
        if (recovering)
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (!retained?.allocation)
                return yield* Effect.fail(failure("no retained setup allocation to reconcile"));
              markRequired = true;
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
          expected = remember(retained);
        }
        if (retained.receipt && !retained.uncertain) return yield* replay(retained);
        if (retained.uncertain || retained.activation !== "unlaunched") {
          duplicate = true;
          return yield* Effect.fail(failure("reconciliation required"));
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
          expected = remember(retained);
        }
        if (retained.uncertain || retained.activation !== "unlaunched" || retained.receipt) {
          duplicate = true;
          return yield* Effect.fail(failure("reconciliation required"));
        }
        const allocation = retained.allocation;
        if (!allocation) return yield* Effect.fail(failure("setup allocation was not retained"));
        // Root's freeze port must preserve the selection winner. Recheck its returned selection.
        yield* current(retained.selection, "activation");
        if (!same(retained.selection, selection))
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
                    markRequired = true; // A lost claim response has an ambiguous durable outcome.
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
                    expected = remember(retained);
                  }).pipe(Effect.provideContext(context)),
                beforeStart: (owner) =>
                  Effect.gen(function* () {
                    // Capture actual ownership before any authority read that could reject it.
                    retained = { ...retained!, owner, activation: "owned" };
                    yield* ports.persistOwner(input, allocation, owner);
                    expected = remember(retained);
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
        if (duplicate || !markRequired) return yield* Effect.failCause(cause);
        const held = yield* ports
          .markUncertain(input, {
            expected,
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
