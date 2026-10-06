import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  PiManagedProcess,
  PiManagedProcessAllocation,
  PiManagedProcessPersistence,
  PiManagedProcessReconciliation,
} from "../provider/pi/PiManagedProcess.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import {
  ProjectWorkVerificationExecutionError,
  ProjectWorkVerificationExecutionSelection,
  verificationExecutionHash,
  type RetainedVerificationResult,
  type VerificationClaim,
  type VerificationExecutionIntent,
  type VerificationExecutionJournal,
  type VerificationExecutionSelection,
  type VerificationExecutionSnapshot,
} from "./ProjectWorkVerificationExecutionJournal.ts";

export interface ProjectWorkVerificationExecutionOptions {
  readonly environmentId: string;
  readonly journal: VerificationExecutionJournal;
  readonly assertEnabled: Effect.Effect<void, ProjectWorkVerificationExecutionError>;
  readonly discover: (input: {
    readonly afterJobId?: string;
    readonly limit: number;
  }) => Effect.Effect<
    { readonly items: readonly VerificationExecutionSelection[]; readonly next?: string },
    ProjectWorkVerificationExecutionError
  >;
  readonly withHost: <A>(
    selection: VerificationExecutionSelection,
    use: (
      allocation: PiManagedProcessAllocation,
    ) => Effect.Effect<A, ProjectWorkVerificationExecutionError, Scope.Scope>,
  ) => Effect.Effect<A, ProjectWorkVerificationExecutionError, Scope.Scope>;
  readonly acquire: (
    claim: VerificationClaim,
    persistence: PiManagedProcessPersistence,
  ) => Effect.Effect<PiManagedProcess, ProjectWorkVerificationExecutionError, Scope.Scope>;
  readonly reconcile: (
    snapshot: VerificationExecutionSnapshot,
  ) => Effect.Effect<PiManagedProcessReconciliation, ProjectWorkVerificationExecutionError>;
  readonly releaseRecoveryObservation?: (
    snapshot: VerificationExecutionSnapshot,
  ) => Effect.Effect<void>;
  readonly environmentSummary: (intent: VerificationExecutionIntent) => string;
  readonly authorityChanges?: Stream.Stream<void, ProjectWorkVerificationExecutionError>;
}
const deny = (reason: string) => new ProjectWorkVerificationExecutionError({ reason });
const decodeSelection = Schema.decodeUnknownSync(ProjectWorkVerificationExecutionSelection, {
  onExcessProperty: "error",
});
const isError = Schema.is(ProjectWorkVerificationExecutionError);
const translate = (error: unknown) =>
  isError(error)
    ? error
    : deny("Verification execution could not complete its exact retained operation");
const copySelection = (input: VerificationExecutionSelection) => {
  const owned: unknown = structuredClone(input);
  const selected = decodeSelection(owned);
  if (canonicalProjectWorkPayload(owned) !== canonicalProjectWorkPayload(selected))
    throw deny("Verification selection changed during decoding");
  return selected;
};

/** One scoped producer joins its own process before retaining any terminal result. */
export const makeProjectWorkVerificationExecution = Effect.fn(
  "ProjectWorkVerificationExecution.make",
)(function* (supplied: ProjectWorkVerificationExecutionOptions) {
  const options = { ...supplied };
  const journal = options.journal;
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* makeProjectWorkArtifacts({
    environmentId: options.environmentId,
    maximumArtifactBytes: 1048576,
  }).pipe(Effect.mapError(translate));
  const scope = yield* Scope.Scope;
  const serial = yield* Semaphore.make(1);
  let stopped = false;
  let active: Fiber.Fiber<void, ProjectWorkVerificationExecutionError> | undefined;
  let activeClaim: VerificationClaim | undefined;
  const provide = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(translate));
  const retain = Effect.fn("VerificationExecution.retain")(function* (
    claim: { readonly attemptId: string; readonly intent: VerificationExecutionIntent },
    input: {
      readonly outcome: RetainedVerificationResult["outcome"];
      readonly exitCode: number | null;
      readonly outputComplete: boolean;
      readonly stdout: Uint8Array;
      readonly stderr: Uint8Array;
      readonly drain: RetainedVerificationResult["drain"];
      readonly reconciliation?: RetainedVerificationResult["reconciliation"];
    },
  ) {
    const job = claim.intent.receipt.manifest;
    const environmentSummary = options.environmentSummary(claim.intent);
    const applicability = {
      projectId: job.projectId,
      taskId: job.taskId,
      specRevision: job.specRevision,
      planRevision: job.planRevision,
      repository: job.target.repository,
      worktree: job.target.worktree,
      testedTree: job.target.testedTree,
      testedCommit: job.target.testedCommit,
      baseSha: job.target.baseSha,
      headSha: job.target.headSha,
      command: canonicalProjectWorkPayload({
        executable: job.command.executable,
        argv: job.command.argv,
      }),
      exitCode: input.exitCode ?? -1,
      environmentSummary,
      integration: false,
    };
    const stdout = yield* artifacts.retain({
      artifactId: claim.attemptId + ":stdout",
      sourceId: claim.attemptId,
      applicability,
      bytes: input.stdout,
    });
    const stderr = yield* artifacts.retain({
      artifactId: claim.attemptId + ":stderr",
      sourceId: claim.attemptId,
      applicability,
      bytes: input.stderr,
    });
    return {
      version: 1 as const,
      jobId: job.jobId,
      attemptId: claim.attemptId,
      manifestHash: claim.intent.receipt.sha256,
      allocationHash: verificationExecutionHash(claim.intent.allocation),
      outcome: input.outcome,
      exitCode: input.exitCode,
      outputComplete: input.outputComplete,
      stdout,
      stderr,
      drain: input.drain,
      ...(input.reconciliation === undefined ? {} : { reconciliation: input.reconciliation }),
      drainHash: verificationExecutionHash(input.drain),
      environmentSummary,
      finishedAtMs: yield* Clock.currentTimeMillis,
    };
  });
  const run = Effect.fn("VerificationExecution.run")(function* (claim: VerificationClaim) {
    const process = yield* options.acquire(claim, journal.persistence(claim));
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let byteCount = 0;
    let overflow = false;
    let outputComplete = false;
    const collect = (stream: PiManagedProcess["stdout"], chunks: Uint8Array[]) =>
      stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const remaining =
              claim.intent.receipt.manifest.command.limits.maxOutputBytes - byteCount;
            const retained = chunk.slice(0, Math.max(0, remaining));
            byteCount += retained.byteLength;
            if (retained.byteLength !== 0) chunks.push(retained);
            if (retained.byteLength !== chunk.byteLength) {
              overflow = true;
              return yield* deny("Verification output bound exceeded");
            }
          }),
        ),
      );
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const remaining = claim.intent.deadlineAtMs - (yield* Clock.currentTimeMillis);
        const observed = yield* restore(
          Effect.gen(function* () {
            if (stopped || remaining <= 0)
              return yield* deny("Verification was stopped or expired before start");
            yield* options.assertEnabled;
            yield* journal.assertCurrent(claim);
            yield* process.start;
            yield* process.endInput;
            const result = yield* Effect.all(
              [collect(process.stdout, out), collect(process.stderr, err), process.awaitExit],
              { concurrency: "unbounded" },
            );
            outputComplete = true;
            return result[2];
          }).pipe(
            Effect.timeoutOption(Math.max(1, remaining)),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        ).pipe(Effect.exit);
        const drained = yield* process.stop.pipe(Effect.exit);
        if (Exit.isFailure(drained)) {
          yield* provide(
            journal.recordUncertain(claim, "Original verification process drainage is unproved"),
          );
          return yield* deny("Original verification process requires reconciliation");
        }
        let outcome: RetainedVerificationResult["outcome"];
        if (overflow) outcome = "overflow";
        else if (Exit.isFailure(observed))
          outcome = Cause.hasInterrupts(observed.cause) ? "canceled" : "failed";
        else if (Option.isNone(observed.value)) outcome = "timed-out";
        else outcome = drained.value.childExitCode === 0 ? "success" : "failed";
        if (outcome === "success") {
          const current = yield* provide(
            options.assertEnabled.pipe(Effect.andThen(journal.assertCurrent(claim))),
          ).pipe(Effect.result);
          if (current._tag === "Failure") outcome = "revoked";
        }
        const result = yield* provide(
          retain(claim, {
            outcome,
            exitCode: drained.value.childExitCode,
            outputComplete,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            drain: drained.value,
          }),
        );
        yield* provide(journal.complete(claim, result));
        if (Exit.isFailure(observed) && Cause.hasInterrupts(observed.cause))
          return yield* Effect.failCause(observed.cause);
      }),
    );
  }, Effect.mapError(translate));
  const recover = Effect.fn("VerificationExecution.recover")(function* () {
    let cursor: string | undefined;
    do {
      const page = yield* provide(
        journal.readRecoveryPage({
          ...(cursor === undefined ? {} : { afterRowId: cursor }),
          limit: 50,
        }),
      );
      for (const snapshot of page.items) {
        yield* Effect.gen(function* () {
          const recovered = yield* options.reconcile(snapshot).pipe(Effect.result);
          if (
            recovered._tag === "Failure" ||
            recovered.success.unit !== snapshot.intent.allocation.unit ||
            recovered.success.state === "owned"
          ) {
            yield* provide(
              journal.quarantineRecovery(
                snapshot,
                "Original verification ownership remains uncertain",
              ),
            );
            return;
          }
          const observed = recovered.success;
          const result = yield* provide(
            retain(snapshot, {
              outcome: "abandoned",
              exitCode: null,
              outputComplete: false,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
              drain: null,
              reconciliation: {
                unit: observed.unit,
                nonce: snapshot.intent.allocation.nonce,
                kernel: observed.kernel,
              },
            }),
          ).pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* provide(
              journal.quarantineRecovery(
                snapshot,
                "Original verification output cannot be reconstructed or replaced",
              ),
            );
            return;
          }
          const settled = yield* provide(journal.finishRecovery(snapshot, result.success)).pipe(
            Effect.result,
          );
          if (settled._tag === "Failure")
            yield* provide(
              journal.quarantineRecovery(
                snapshot,
                "Original verification cleanup result could not be retained",
              ),
            );
        }).pipe(Effect.ensuring(options.releaseRecoveryObservation?.(snapshot) ?? Effect.void));
      }
      if (page.next !== undefined && page.next === cursor)
        return yield* deny("Verification recovery cursor did not advance");
      cursor = page.next;
    } while (cursor !== undefined);
  });
  const ready = yield* provide(recover()).pipe(Effect.cached);
  const sweep = provide(
    serial.withPermits(1)(
      Effect.gen(function* () {
        yield* ready;
        if (stopped) return;
        yield* options.assertEnabled;
        let cursor: string | undefined;
        do {
          const page = yield* options.discover({
            ...(cursor === undefined ? {} : { afterJobId: cursor }),
            limit: 50,
          });
          if (page.items.length > 50)
            return yield* deny("Verification discovery exceeds its page bound");
          for (const input of page.items) {
            if (stopped) return;
            yield* options.assertEnabled;
            const selection = yield* Effect.try({
              try: () => copySelection(input),
              catch: translate,
            });
            if (yield* provide(journal.readResult(selection.receipt.manifest.jobId))) continue;
            yield* options
              .withHost(selection, (allocation) =>
                Effect.gen(function* () {
                  if (stopped) return;
                  yield* options.assertEnabled;
                  const outcome = yield* provide(
                    journal.claim({
                      ...selection,
                      allocation,
                      deadlineAtMs:
                        (yield* Clock.currentTimeMillis) +
                        selection.receipt.manifest.command.limits.maxDurationMs,
                    }),
                  );
                  if (outcome._tag !== "Claimed") return;
                  activeClaim = outcome.claim;
                  active = yield* Effect.forkIn(
                    provide(Effect.scoped(run(outcome.claim))).pipe(
                      Effect.catch((error) =>
                        provide(
                          journal.recordUncertain(
                            outcome.claim,
                            "Original verification did not produce a committed terminal result",
                          ),
                        ).pipe(Effect.andThen(Effect.fail(error))),
                      ),
                    ),
                    scope,
                  );
                  yield* Fiber.join(active).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        active = undefined;
                        activeClaim = undefined;
                      }),
                    ),
                  );
                }).pipe(Effect.mapError(translate)),
              )
              .pipe(Effect.scoped);
          }
          if (page.next !== undefined && page.next === cursor)
            return yield* deny("Verification discovery cursor did not advance");
          cursor = page.next;
          if (stopped) return;
        } while (cursor !== undefined);
      }),
    ),
  );
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      stopped = true;
      const running = active;
      if (running) {
        yield* Fiber.interrupt(running);
        const result = yield* Fiber.await(running);
        if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause))
          return yield* Effect.failCause(result.cause);
      }
    }),
  );
  if (options.authorityChanges)
    yield* options.authorityChanges.pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const claim = activeClaim;
          const running = active;
          if (!claim || !running) return;
          const current = yield* provide(
            options.assertEnabled.pipe(Effect.andThen(journal.assertCurrent(claim))),
          ).pipe(Effect.result);
          if (current._tag === "Failure" && active === running) yield* Fiber.interrupt(running);
        }),
      ),
      Effect.forkIn(scope),
    );
  yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie));
  return { ready, sweep, stop };
});
