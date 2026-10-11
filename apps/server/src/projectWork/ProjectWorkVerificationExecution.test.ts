import { expect, it } from "@effect/vitest";
import {
  CommandId,
  canonicalProjectWorkPayload,
  ProjectTeamGate,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { scoped, at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { makeVerificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectWorkVerificationGate } from "./ProjectWorkVerificationGate.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import {
  makeProjectWorkVerificationExecutionJournal,
  ProjectWorkVerificationExecutionError,
  verificationExecutionHash,
  type VerificationExecutionIntent,
} from "./ProjectWorkVerificationExecutionJournal.ts";

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  makeProjectWorkVerificationExecution,
  type ProjectWorkVerificationExecutionOptions,
} from "./ProjectWorkVerificationExecution.ts";
import {
  PiManagedProcessError,
  type PiManagedProcess,
  type PiManagedProcessAllocation,
} from "../provider/pi/PiManagedProcess.ts";
const decodeGate = Schema.decodeUnknownSync(ProjectTeamGate);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const attribution = {
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "verification-control" },
  recordedAt: at,
} as const;
const makeFixture = Effect.fn("makeExecutionFixture")(function* (
  role: "implementer" | "integrator" = "implementer",
) {
  const f = yield* makeVerificationFixture(role);
  const repository = yield* ProjectWorkRepository;
  const gate = decodeGate({
    kind: "gate",
    projectId: f.selection.projectId,
    recordId: "verification-gate",
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "approved",
    taskId: f.selection.taskId,
    gate: "verification",
    specRevision: f.selection.specRevision,
    planRevision: f.selection.planRevision,
    contentHash: f.prepared.sha256,
    verificationJobId: f.selection.jobId,
    attribution,
    evidenceIds: [],
  });
  yield* repository.execute(
    decodeCommit({
      type: "project-work.foundation.commit",
      projectId: f.selection.projectId,
      commandId: "seed-verification-gate",
      expectedRevision: (yield* readCurrentState(f.sql, f.selection.projectId)).revision,
      attribution,
      records: [gate],
      committedAt: at,
    }),
  );
  const nonce = "11111111-1111-4111-8111-111111111111";
  const allocation = {
    version: 1 as const,
    unit: `t3-pi-managed-${nonce}.service`,
    nonce,
    policy: { memoryBytes: 536870912, runtimeSeconds: 1 },
    launch: {
      workspaceRoot: "/workspace-assigned",
      workspaceAccess: "readonly" as const,
      protectedRoots: ["/protected"],
      runtimeFiles: [{ source: "/published/bash", target: "/bin/bash", dev: 1, ino: 10 }],
      argv: ["/bin/bash", "-n", "test.sh"],
      memoryBytes: 536870912,
      runtimeSeconds: 1,
      workspace: { path: "/workspace-assigned", dev: 1, ino: 2 },
      protectedWorkspaceEntries: [],
    },
  };
  const intent: VerificationExecutionIntent = {
    receipt: f.prepared,
    gate,
    allocation,
    deadlineAtMs: (yield* Clock.currentTimeMillis) + 1000,
  };
  const approval = yield* makeProjectWorkVerificationGate({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  let revoked = false;
  const options = {
    environmentId: "environment",
    assertCurrent: (
      selected: VerificationExecutionIntent,
      state: typeof f.state,
      phase: "approved" | "consumed",
      attemptId: string,
    ) =>
      Effect.gen(function* () {
        if (revoked)
          return yield* new ProjectWorkVerificationExecutionError({
            reason: "Controlled current grant revoked",
          });
        yield* approval
          .assertCurrent(state, selected.receipt, f.selection, true)
          .pipe(
            Effect.mapError(
              () => new ProjectWorkVerificationExecutionError({ reason: "Current target changed" }),
            ),
          );
        const gates = (state.foundationRecords ?? []).filter(
          (r) => r.kind === "gate" && r.recordId === selected.gate.recordId,
        );
        const current = gates[0];
        if (
          gates.length !== 1 ||
          current?.kind !== "gate" ||
          current.status !== (phase === "approved" ? "approved" : "consumed") ||
          current.contentHash !== selected.receipt.sha256 ||
          (phase === "consumed" && current.consumedByRunId !== attemptId)
        )
          return yield* new ProjectWorkVerificationExecutionError({
            reason: "Current approval changed",
          });
      }),
    consumeApproval: (
      selected: VerificationExecutionIntent,
      attemptId: string,
      state: typeof f.state,
    ) =>
      Effect.succeed([
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId: state.projectId,
          commandId: CommandId.make("verification-claim:" + attemptId),
          expectedRevision: state.revision,
          attribution: {
            actor: { kind: "system", id: "project-team-verification" },
            source: { kind: "system", id: "project-team-verification" },
            recordedAt: at,
          },
          records: [],
          committedAt: at,
          transition: {
            kind: "verification.claim",
            taskId: selected.receipt.manifest.taskId,
            expectedTaskRevision: f.selection.expectedTaskRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
            jobId: selected.receipt.manifest.jobId,
            manifestHash: selected.receipt.sha256,
            attemptId,
          },
        }),
      ]),
    verifyResult: () => Effect.void,
  };
  // Controlled execution tests retain an already-established original task budget.
  // Production standalone budget bootstrap is deliberately still unavailable.
  yield* f.sql`INSERT INTO project_task_resource_budget VALUES('environment',${f.selection.projectId},${f.selection.taskId},${intent.deadlineAtMs + 300000},2147483648)`;
  const journal = yield* makeProjectWorkVerificationExecutionJournal(options);
  const owner = {
    type: "owner" as const,
    unit: allocation.unit,
    nonce,
    invocation: "a".repeat(32),
    cgroup: "/sys/fs/cgroup/controlled/" + allocation.unit,
    pid: 200,
    memoryBytes: allocation.policy.memoryBytes,
    swapBytes: 0,
    oomGroup: 1,
  };
  const drain = {
    unit: allocation.unit,
    invocation: owner.invocation,
    cgroup: owner.cgroup,
    ownerPid: 200,
    memoryBytes: allocation.policy.memoryBytes,
    swapBytes: 0,
    oomGroup: 1,
    launcherPid: 100,
    childPid: 300,
    childExitCode: 0,
    kernel: "populated 0",
  };
  return {
    ...f,
    intent,
    options,
    journal,
    owner,
    drain,
    revoke: () => {
      revoked = true;
    },
  };
});

const controlled = (
  config: {
    readonly role?: "implementer" | "integrator";
    readonly held?: boolean;
    readonly code?: number;
    readonly stdout?: readonly Uint8Array[];
    readonly stderr?: readonly Uint8Array[];
  } = {},
) =>
  Effect.gen(function* () {
    const f = yield* makeFixture(config.role);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const commands: ChildProcess.Command[] = [];
    let starts = 0;
    let stops = 0;
    let inputClosed = 0;
    let captures = 0;
    let discoveries = 0;
    let reconciles = 0;
    let done = false;
    const observations = new Set<string>();
    const journal = yield* makeProjectWorkVerificationExecutionJournal({
      ...f.options,
      verifyResult: (_intent, result) =>
        observations.has(result.drainHash) ||
        observations.has(verificationExecutionHash(result.reconciliation))
          ? Effect.void
          : Effect.fail(
              new ProjectWorkVerificationExecutionError({
                reason: "No actual controlled observation",
              }),
            ),
    });
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(command);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(300),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(config.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromIterable(config.stdout ?? [new Uint8Array([0, 255, 10])]),
          stderr: Stream.fromIterable(config.stderr ?? [new Uint8Array([27, 0])]),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const drain = Effect.gen(function* () {
      if (config.held && !done) yield* Deferred.await(release);
      done = true;
      const value = { ...f.drain, childExitCode: config.code ?? 0 };
      observations.add(verificationExecutionHash(value));
      return value;
    });
    const options = {
      environmentId: "environment",
      journal,
      assertEnabled: Effect.void,
      discover: () =>
        Effect.sync(() => {
          discoveries++;
          return { items: [{ receipt: f.prepared, gate: f.intent.gate }] };
        }),
      withHost: <A>(
        _selection: { readonly receipt: typeof f.prepared },
        use: (
          allocation: PiManagedProcessAllocation,
        ) => Effect.Effect<A, ProjectWorkVerificationExecutionError, import("effect/Scope").Scope>,
      ) =>
        Effect.gen(function* () {
          captures++;
          return yield* use(f.intent.allocation);
        }),
      acquire: (
        _claim: import("./ProjectWorkVerificationExecutionJournal.ts").VerificationClaim,
        persistence: import("../provider/pi/PiManagedProcess.ts").PiManagedProcessPersistence,
      ) =>
        Effect.gen(function* () {
          yield* persistence
            .claimActivation(f.intent.allocation)
            .pipe(
              Effect.mapError(
                () => new ProjectWorkVerificationExecutionError({ reason: "Activation denied" }),
              ),
            );
          const child = yield* spawner
            .spawn(
              ChildProcess.make("/bin/bash", ["-n", "test.sh"], {
                cwd: "/workspace",
                shell: false,
                extendEnv: false,
                env: { HOME: "/workspace", PATH: "/runtime:/bin" },
                stdin: "pipe",
              }),
            )
            .pipe(
              Effect.mapError(
                () =>
                  new ProjectWorkVerificationExecutionError({ reason: "Controlled spawn failed" }),
              ),
            );
          const process: PiManagedProcess = {
            owner: f.owner,
            start: Effect.gen(function* () {
              yield* persistence.beforeStart(f.owner);
              starts++;
              yield* Deferred.succeed(started, undefined);
              return 300;
            }),
            send: () => Effect.void,
            endInput: Effect.sync(() => {
              inputClosed++;
            }),
            stdout: Stream.fromEffect(Deferred.await(started)).pipe(
              Stream.flatMap(() => child.stdout),
              Stream.mapError(
                () =>
                  new PiManagedProcessError({
                    phase: "transport",
                    message: "Controlled stdout read failed",
                  }),
              ),
            ),
            stderr: Stream.fromEffect(Deferred.await(started)).pipe(
              Stream.flatMap(() => child.stderr),
              Stream.mapError(
                () =>
                  new PiManagedProcessError({
                    phase: "transport",
                    message: "Controlled stderr read failed",
                  }),
              ),
            ),
            awaitExit: drain,
            stop: Effect.gen(function* () {
              if (!done) {
                stops++;
                done = true;
                yield* Deferred.succeed(release, undefined);
              }
              return yield* drain;
            }),
          };
          return process;
        }),
      reconcile: (
        snapshot: import("./ProjectWorkVerificationExecutionJournal.ts").VerificationExecutionSnapshot,
      ) =>
        Effect.sync(() => {
          reconciles++;
          const result = {
            state: "drained" as const,
            unit: snapshot.intent.allocation.unit,
            invocation: snapshot.owner?.invocation ?? null,
            cgroup: snapshot.owner?.cgroup ?? null,
            kernel: "removed",
          };
          observations.add(
            verificationExecutionHash({
              unit: result.unit,
              nonce: snapshot.intent.allocation.nonce,
              kernel: result.kernel,
            }),
          );
          return result;
        }),
      environmentSummary: () => "controlled-linux clean readonly",
    } satisfies ProjectWorkVerificationExecutionOptions;
    return {
      ...f,
      journal,
      options,
      started,
      release,
      observations,
      counters: () => ({ starts, stops, inputClosed, captures, discoveries, reconciles }),
      commands,
    };
  });

for (const role of ["implementer", "integrator"] as const)
  it.effect(
    `the existing native admission hold prevents any approved ${role} job capture or spawn`,
    () =>
      scoped(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* controlled({ role });
            const execution = yield* makeProjectWorkVerificationExecution({
              ...f.options,
              assertEnabled: Effect.fail(
                new ProjectWorkVerificationExecutionError({
                  reason: "Managed execution awaits retained engineering verdicts",
                }),
              ),
            });
            yield* execution.ready;
            expect(yield* execution.sweep.pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "ProjectWorkVerificationExecutionError" },
            });
            expect(f.commands).toEqual([]);
            expect(f.counters().discoveries).toBe(0);
          }),
        ),
      ),
  );

for (const role of ["implementer", "integrator"] as const)
  it.effect(
    `an approved ${role} job produces one drained binary result and repeat wakes never launch it again`,
    () =>
      scoped(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* controlled({ role });
            const execution = yield* makeProjectWorkVerificationExecution(f.options);
            yield* execution.ready;
            yield* execution.sweep;
            const result = yield* f.journal.readResult(f.selection.jobId);
            expect(result).toMatchObject({
              outcome: "success",
              exitCode: 0,
              outputComplete: true,
              stdout: { byteCount: 3 },
              stderr: { byteCount: 2 },
              drain: { childPid: 300, childExitCode: 0 },
            });
            const artifacts = yield* makeProjectWorkArtifacts({
              environmentId: "environment",
              maximumArtifactBytes: 4096,
            });
            expect((yield* artifacts.readRetained(result!.stdout.artifactId))?.bytes).toEqual(
              new Uint8Array([0, 255, 10]),
            );
            for (const output of [result!.stdout, result!.stderr]) {
              const retained = yield* artifacts.readRetained(output.artifactId);
              expect(retained?.applicability.integration).toBe(role === "integrator");
            }
            expect((yield* artifacts.readRetained(result!.stderr.artifactId))?.bytes).toEqual(
              new Uint8Array([27, 0]),
            );
            const state = yield* readCurrentState(f.sql, f.selection.projectId);
            expect(
              state.foundationRecords?.find((row) => row.kind === "evidence-applicability"),
            ).toMatchObject({ integration: role === "integrator", status: "current" });
            expect(state.tasks.find((row) => row.taskId === f.selection.taskId)?.state).not.toBe(
              "completed",
            );
            yield* execution.sweep;
            expect(f.counters().starts).toBe(1);
            expect(f.counters().inputClosed).toBe(1);
            expect(f.commands).toHaveLength(1);
          }),
        ),
      ),
  );

it.effect("an invalidated grant stops its exact running process before the held child exit", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* controlled({ held: true });
        const changes = yield* Queue.unbounded<void>();
        const execution = yield* makeProjectWorkVerificationExecution({
          ...f.options,
          authorityChanges: Stream.fromQueue(changes),
        });
        const sweeping = yield* execution.sweep.pipe(Effect.forkScoped);
        yield* Deferred.await(f.started);
        f.revoke();
        yield* Queue.offer(changes, undefined);
        yield* Fiber.await(sweeping);
        expect(f.counters().stops).toBe(1);
        expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
          outcome: "canceled",
          outputComplete: false,
        });
        yield* execution.sweep;
        expect(f.counters().starts).toBe(1);
      }),
    ),
  ),
);

it.effect("settings disable stops the active process through the current-settings hint", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* controlled({ held: true });
        const changes = yield* Queue.unbounded<void>();
        let enabled = true;
        let hints = 0;
        const handled = yield* Deferred.make<void>();
        const execution = yield* makeProjectWorkVerificationExecution({
          ...f.options,
          assertEnabled: Effect.suspend(() =>
            enabled
              ? Effect.void
              : Effect.fail(
                  new ProjectWorkVerificationExecutionError({ reason: "Execution disabled" }),
                ),
          ),
          authorityChanges: Stream.fromQueue(changes).pipe(
            Stream.tap(() => (++hints === 2 ? Deferred.succeed(handled, undefined) : Effect.void)),
          ),
        });
        const sweeping = yield* execution.sweep.pipe(Effect.forkScoped);
        yield* Deferred.await(f.started);
        enabled = false;
        yield* Queue.offer(changes, undefined);
        yield* Queue.offer(changes, undefined);
        // Reaching the second hint proves the first handler completed, before natural exit.
        yield* Deferred.await(handled);
        const stoppedBeforeExit = f.counters().stops;
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.await(sweeping);
        expect(stoppedBeforeExit).toBe(1);
        expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
          outcome: "canceled",
          outputComplete: false,
        });
      }),
    ),
  ),
);

it.effect("missing hints cannot turn a revoked grant into success at natural completion", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* controlled({ held: true });
        const execution = yield* makeProjectWorkVerificationExecution(f.options);
        const sweeping = yield* execution.sweep.pipe(Effect.forkScoped);
        yield* Deferred.await(f.started);
        f.revoke();
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(sweeping);
        expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
          outcome: "revoked",
          exitCode: 0,
        });
        yield* execution.sweep;
        expect(f.counters().starts).toBe(1);
      }),
    ),
  ),
);

it.effect(
  "startup reconciles a retained allocation as abandoned and never launches its consumed job",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* controlled();
          expect((yield* f.journal.claim(f.intent))._tag).toBe("Claimed");
          const execution = yield* makeProjectWorkVerificationExecution(f.options);
          yield* execution.ready;
          expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
            outcome: "abandoned",
            exitCode: null,
            drain: null,
            outputComplete: false,
            stdout: { byteCount: 0 },
            stderr: { byteCount: 0 },
          });
          yield* execution.sweep;
          expect(f.commands).toEqual([]);
          expect(f.counters().reconciles).toBe(1);
        }),
      ),
    ),
);

for (const outcome of ["terminal", "quarantine", "failure"] as const)
  it.effect(
    `recovery releases private observation after ${outcome} and keeps it through SQL settlement`,
    () =>
      scoped(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* controlled();
            expect((yield* f.journal.claim(f.intent))._tag).toBe("Claimed");
            let retained = false;
            let released = 0;
            const journal = {
              ...f.journal,
              finishRecovery: (...args: Parameters<typeof f.journal.finishRecovery>) =>
                Effect.gen(function* () {
                  expect(retained).toBe(true);
                  return yield* f.journal.finishRecovery(...args);
                }),
              quarantineRecovery: (...args: Parameters<typeof f.journal.quarantineRecovery>) =>
                Effect.gen(function* () {
                  expect(retained).toBe(true);
                  if (outcome === "failure")
                    return yield* new ProjectWorkVerificationExecutionError({
                      reason: "controlled quarantine failure",
                    });
                  return yield* f.journal.quarantineRecovery(...args);
                }),
            };
            const execution = yield* makeProjectWorkVerificationExecution({
              ...f.options,
              journal,
              reconcile: (snapshot) =>
                f.options.reconcile(snapshot).pipe(
                  Effect.map((receipt) => {
                    retained = true;
                    return outcome === "terminal"
                      ? receipt
                      : { ...receipt, state: "owned" as const };
                  }),
                ),
              releaseRecoveryObservation: () =>
                Effect.sync(() => {
                  retained = false;
                  released++;
                }),
            });
            const ready = yield* execution.ready.pipe(Effect.result);
            expect(ready._tag).toBe(outcome === "failure" ? "Failure" : "Success");
            expect(retained).toBe(false);
            expect(released).toBe(1);
            if (outcome === "terminal")
              expect((yield* f.journal.readResult(f.selection.jobId))?.outcome).toBe("abandoned");
            if (outcome === "quarantine")
              expect((yield* f.journal.readRecoveryPage({ limit: 1 })).items[0]?.phase).toBe(
                "quarantine",
              );
          }),
        ),
      ),
  );

it.effect("a nonzero observed child exit is retained as failure with separate exact streams", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* controlled({ code: 7 });
        const execution = yield* makeProjectWorkVerificationExecution(f.options);
        yield* execution.sweep;
        expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
          outcome: "failed",
          exitCode: 7,
          outputComplete: true,
          drain: { childExitCode: 7 },
          stdout: { byteCount: 3 },
          stderr: { byteCount: 2 },
        });
        yield* execution.sweep;
        expect(f.counters().starts).toBe(1);
      }),
    ),
  ),
);

it.effect(
  "aggregate output overflow retains only its bounded binary prefix and never success",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const bytes = new Uint8Array(5000).fill(255);
          const f = yield* controlled({ stdout: [bytes] });
          const execution = yield* makeProjectWorkVerificationExecution(f.options);
          yield* execution.sweep;
          const result = yield* f.journal.readResult(f.selection.jobId);
          expect(result).toMatchObject({ outcome: "overflow", outputComplete: false });
          expect(result!.stdout.byteCount + result!.stderr.byteCount).toBe(4096);
          const artifacts = yield* makeProjectWorkArtifacts({
            environmentId: "environment",
            maximumArtifactBytes: 4096,
          });
          const retained = yield* artifacts.readRetained(result!.stdout.artifactId);
          expect(retained?.bytes).toEqual(bytes.slice(0, result!.stdout.byteCount));
          expect(f.counters().stops).toBe(1);
        }),
      ),
    ),
);

it.effect(
  "the approved deadline stops a held child and retains a timed-out incomplete result",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* controlled({ held: true });
          const execution = yield* makeProjectWorkVerificationExecution(f.options);
          const sweeping = yield* execution.sweep.pipe(Effect.forkScoped);
          yield* Deferred.await(f.started);
          yield* TestClock.adjust(1001);
          yield* Fiber.join(sweeping);
          expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
            outcome: "timed-out",
            outputComplete: false,
          });
          expect(f.counters().stops).toBe(1);
        }),
      ),
    ),
);

it.effect("explicit stop joins its exact drain before returning and prevents later discovery", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* controlled({ held: true });
        const execution = yield* makeProjectWorkVerificationExecution(f.options);
        const sweeping = yield* execution.sweep.pipe(Effect.forkScoped);
        yield* Deferred.await(f.started);
        yield* execution.stop;
        yield* Fiber.await(sweeping);
        expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
          outcome: "canceled",
          outputComplete: false,
        });
        const previous = f.counters();
        yield* execution.sweep;
        expect(f.counters()).toEqual(previous);
        expect(previous.stops).toBe(1);
      }),
    ),
  ),
);

it.effect(
  "revocation between acquisition and start does not start the child or create success",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* controlled();
          const execution = yield* makeProjectWorkVerificationExecution({
            ...f.options,
            acquire: (claim, persistence) =>
              f.options.acquire(claim, persistence).pipe(
                Effect.map((process) => ({
                  ...process,
                  start: Effect.sync(f.revoke).pipe(Effect.andThen(process.start)),
                })),
              ),
          });
          yield* execution.sweep;
          expect(f.counters().starts).toBe(0);
          expect(f.counters().stops).toBe(1);
          expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
            outcome: "failed",
            outputComplete: false,
          });
        }),
      ),
    ),
);

it.effect("restart cannot overwrite a retained raw artifact when its final result is missing", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* controlled();
        const outcome = yield* f.journal.claim(f.intent);
        if (outcome._tag !== "Claimed") return yield* Effect.die("Missing claim");
        const job = f.prepared.manifest;
        const artifacts = yield* makeProjectWorkArtifacts({
          environmentId: "environment",
          maximumArtifactBytes: 4096,
        });
        const artifact = yield* artifacts.retain({
          artifactId: outcome.claim.attemptId + ":stdout",
          sourceId: outcome.claim.attemptId,
          bytes: new Uint8Array([0, 255]),
          applicability: {
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
            exitCode: 7,
            environmentSummary: "controlled-linux clean readonly",
            integration: false,
          },
        });
        const execution = yield* makeProjectWorkVerificationExecution(f.options);
        yield* execution.ready;
        expect(yield* f.journal.readResult(job.jobId)).toBeUndefined();
        expect((yield* f.journal.claim(f.intent))._tag).toBe("Uncertain");
        expect((yield* artifacts.readRetained(artifact.artifactId))?.bytes).toEqual(
          new Uint8Array([0, 255]),
        );
        yield* execution.sweep;
        expect(f.counters().starts).toBe(0);
        expect(f.counters().reconciles).toBe(1);
      }),
    ),
  ),
);

it.effect(
  "unproved process drainage quarantines the original attempt without retaining success or relaunch",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* controlled();
          const execution = yield* makeProjectWorkVerificationExecution({
            ...f.options,
            acquire: (claim, persistence) =>
              f.options.acquire(claim, persistence).pipe(
                Effect.map((process) => ({
                  ...process,
                  stop: Effect.fail(
                    new PiManagedProcessError({
                      phase: "quarantine",
                      message: "Controlled drain unavailable",
                    }),
                  ),
                })),
              ),
          });
          expect((yield* execution.sweep.pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.journal.readResult(f.selection.jobId)).toBeUndefined();
          expect((yield* f.journal.claim(f.intent))._tag).toBe("Uncertain");
          yield* execution.sweep;
          expect(f.counters().starts).toBe(1);
        }),
      ),
    ),
);

it.effect(
  "task resources verification recovery consumes actual matched owner drain without extending expiry",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* controlled();
          const claimed = yield* f.journal.claim(f.intent);
          if (claimed._tag !== "Claimed")
            return yield* Effect.die("Missing original verification claim");
          const persistence = f.journal.persistence(claimed.claim);
          yield* persistence.claimActivation(f.intent.allocation);
          yield* persistence.beforeStart(f.owner);
          yield* TestClock.setTime(f.intent.deadlineAtMs + 1);
          const execution = yield* makeProjectWorkVerificationExecution(f.options);
          yield* execution.ready;
          expect(yield* f.journal.readResult(f.selection.jobId)).toMatchObject({
            outcome: "abandoned",
            drain: null,
          });
          expect(
            yield* f.sql`SELECT COUNT(*) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
          ).toEqual([{ held: 0 }]);
          expect(f.commands).toEqual([]);
          expect(f.counters().reconciles).toBe(1);
        }),
      ),
    ),
);
