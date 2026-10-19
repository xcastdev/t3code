import { canonicalProjectWorkPayload, GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import {
  acquirePiManagedProcess,
  PiManagedProcessError,
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
  type PiManagedProcessAllocation,
  type PiManagedProcessPersistence,
} from "../provider/pi/PiManagedProcess.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { ProjectWorkEventBus } from "./ProjectWorkEventBus.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectWorkVerificationExecutionGrant } from "./ProjectWorkVerificationExecutionGrant.ts";
import { withProjectWorkVerificationExecutable } from "./ProjectWorkVerificationExecutable.ts";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";
import {
  makeProjectWorkVerificationExecutionJournal,
  ProjectWorkVerificationExecutionSelection,
  ProjectWorkVerificationExecutionError,
  verificationExecutionHash,
  type VerificationClaim,
  type VerificationExecutionIntent,
  type VerificationExecutionSnapshot,
  type RetainedVerificationResult,
} from "./ProjectWorkVerificationExecutionJournal.ts";

const decodeSelection = Schema.decodeUnknownEffect(ProjectWorkVerificationExecutionSelection);
const decodeWorkspaceReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
);
type Selection = typeof ProjectWorkVerificationExecutionSelection.Type;
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const denied = (reason: string) => new ProjectWorkVerificationExecutionError({ reason });
const isError = Schema.is(ProjectWorkVerificationExecutionError);
const isManagedProcessError = Schema.is(PiManagedProcessError);
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isError(error) ? error : denied("Verification host evidence unavailable"),
    ),
  );

export const makeProjectWorkVerificationExecutionHost = Effect.fn("VerificationExecutionHost.make")(
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
    readonly protectedRoots: readonly string[];
    readonly nativeAdmission: Effect.Effect<void, ProjectWorkVerificationExecutionError>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const workflow = yield* GitWorkflowService;
    const pi = yield* ProjectTeamPiRuntime;
    const bus = yield* ProjectWorkEventBus;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcessPlatform;
    const crypto = yield* Crypto.Crypto;
    const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, platform),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    const dispatch = yield* makeProjectTeamDispatchJournal({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: options.maximumEnvironmentModelCalls,
    });
    const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: options.environmentId });
    const assertEnabled = boundary(
      Effect.gen(function* () {
        yield* options.nativeAdmission;
        const current = yield* settings.getSettings;
        if (!current.projectWorkEnabled || !current.projectTeamExecutionEnabled)
          return yield* denied("Verification execution is disabled");
      }),
    );
    const grant = yield* makeProjectWorkVerificationExecutionGrant({ ...options, assertEnabled });
    const active = new Map<
      string,
      {
        readonly allocation: PiManagedProcessAllocation;
        readonly selection: Selection;
        readonly revalidate: Effect.Effect<void, ProjectWorkVerificationExecutionError>;
      }
    >();
    const observations = new Map<
      string,
      {
        readonly allocationHash: string;
        readonly hash: string;
        readonly kind: "drain" | "reconciliation";
      }
    >();
    const grantCurrent = (
      selection: Selection,
      phase: "approved" | "consumed",
      attemptId: string,
    ) =>
      boundary(
        sql.withTransaction(
          readCurrentState(sql, selection.receipt.manifest.projectId).pipe(
            Effect.flatMap((state) => grant.assertCurrent(selection, state, phase, attemptId)),
          ),
        ),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const verifyResult = (
      intent: VerificationExecutionIntent,
      result: RetainedVerificationResult,
    ) =>
      Effect.gen(function* () {
        const observation = observations.get(result.attemptId);
        const receipt = result.drain ?? result.reconciliation;
        if (
          !receipt ||
          !observation ||
          observation.allocationHash !== verificationExecutionHash(intent.allocation) ||
          observation.hash !== verificationExecutionHash(receipt) ||
          (result.drain === null &&
            (observation.kind !== "reconciliation" || result.outcome === "success"))
        )
          return yield* denied("Verification result has no original host observation");
      });
    const journal = yield* makeProjectWorkVerificationExecutionJournal({
      environmentId: options.environmentId,
      consumeApproval: grant.consumeApproval,
      assertCurrent: (intent, state, phase, attemptId) =>
        grant.assertCurrent(intent, state, phase, attemptId).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const owned = active.get(intent.receipt.manifest.jobId);
              if (
                !owned ||
                !same(owned.allocation, intent.allocation) ||
                !same(owned.selection, { receipt: intent.receipt, gate: intent.gate })
              )
                return Effect.fail(denied("Verification host loan is not current"));
              return owned.revalidate;
            }),
          ),
          Effect.tap(() => grant.assertCurrent(intent, state, phase, attemptId)),
        ),
      verifyResult,
    });
    const discover = Effect.fn("VerificationExecutionHost.discover")(function* (input: {
      readonly afterJobId?: string;
      readonly limit: number;
    }) {
      yield* assertEnabled;
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)
        return yield* denied("Verification discovery page is invalid");
      const rows =
        yield* sql`SELECT job_id FROM project_work_verification_jobs WHERE environment_id=${options.environmentId} AND job_id>${input.afterJobId ?? ""} ORDER BY job_id LIMIT ${input.limit + 1}`;
      const items: Selection[] = [];
      for (const row of rows.slice(0, input.limit)) {
        if (typeof row.job_id !== "string")
          return yield* denied("Verification job identity changed");
        const receipt = yield* jobs.readPrepared(row.job_id);
        if (!receipt) continue;
        const state = yield* readCurrentState(sql, receipt.manifest.projectId);
        const gates = (state.foundationRecords ?? []).filter(
          (r) =>
            r.kind === "gate" &&
            r.gate === "verification" &&
            r.verificationJobId === row.job_id &&
            r.status === "approved",
        );
        if (gates.length !== 1) continue;
        const selected = yield* decodeSelection({ receipt, gate: gates[0] });
        const eligible = yield* grantCurrent(selected, "approved", "discovery").pipe(Effect.result);
        if (eligible._tag === "Success") items.push(selected);
      }
      const last = rows.slice(0, input.limit).at(-1)?.job_id;
      return {
        items,
        ...(rows.length > input.limit && typeof last === "string" ? { next: last } : {}),
      };
    }, boundary);
    const withHost = <A>(
      selection: Selection,
      use: (
        allocation: PiManagedProcessAllocation,
      ) => Effect.Effect<A, ProjectWorkVerificationExecutionError, Scope.Scope>,
    ) =>
      boundary(
        Effect.gen(function* () {
          const job = selection.receipt.manifest;
          yield* grantCurrent(selection, "approved", "capture");
          const snapshot = yield* dispatch.readRetained(job.dispatchId);
          const original =
            yield* sql`SELECT receipt_json FROM project_team_workspace_receipt WHERE dispatch_id=${job.dispatchId} AND environment_id=${options.environmentId} AND binding_id=${job.bindingId} AND generation=${job.generation} AND claim_generation=${snapshot.fence.claimGeneration} AND length(CAST(receipt_json AS BLOB))<=262144 LIMIT 2`;
          if (original.length !== 1)
            return yield* denied("Original verification workspace is unavailable");
          const receipt = yield* decodeWorkspaceReceipt(original[0]?.receipt_json);
          const state = yield* readCurrentState(sql, job.projectId);
          const binding = state.foundationRecords?.find((r) => r.recordId === job.bindingId);
          if (binding?.kind !== "run-binding")
            return yield* denied("Original verification binding unavailable");
          return yield* workflow.withRepositoryPermit(
            "verification.capture",
            receipt.assignment.primaryRoot,
            pi
              .withInstance(binding.providerInstanceId, (instance) =>
                Effect.gen(function* () {
                  // Capture callbacks check durable targets without recursively acquiring the Git permit.
                  const context = yield* ManagedGit.make({
                    assignment: snapshot.intent.request.git,
                    priorReceipt: receipt,
                    revalidate: instance.assertCurrent.pipe(
                      Effect.mapError(
                        () =>
                          new GitCommandError({
                            operation: "VerificationExecutionHost",
                            command: "/usr/bin/git",
                            cwd: job.target.worktree,
                            detail: "Original published runtime unavailable",
                          }),
                      ),
                    ),
                    persistWorkspace: () =>
                      Effect.fail(
                        new GitCommandError({
                          operation: "VerificationExecutionHost",
                          command: "/usr/bin/git",
                          cwd: job.target.worktree,
                          detail: "Verification cannot create a workspace",
                        }),
                      ),
                  });
                  const checkTarget = (target: ManagedGit.ManagedVerificationTarget) => {
                    if (
                      target.cwd !== job.target.worktree ||
                      target.baseSha !== job.target.baseSha ||
                      target.headSha !== job.target.headSha ||
                      target.testedCommit !== job.target.testedCommit ||
                      target.testedTree !== job.target.testedTree ||
                      verificationExecutionHash(target.receipt) !== job.workspaceReceiptHash
                    )
                      return Effect.fail(denied("Original verification workspace changed"));
                    return Effect.void;
                  };
                  const checkExecutable = (captured: {
                    readonly executableTarget: string;
                    readonly sha256: string;
                    readonly runtimeClosureSha256: string;
                  }) =>
                    same(captured, {
                      executableTarget: job.executable.target,
                      sha256: job.executable.sha256,
                      runtimeClosureSha256: job.executable.runtimeClosureSha256,
                    })
                      ? Effect.void
                      : Effect.fail(denied("Original verification executable changed"));
                  const revalidate = boundary(
                    ManagedGit.withManagedVerificationTarget(context, checkTarget).pipe(
                      Effect.andThen(
                        withProjectWorkVerificationExecutable(
                          instance.assets,
                          job.command.executable,
                          checkExecutable,
                        ),
                      ),
                      Effect.andThen(instance.assertCurrent),
                    ),
                  ).pipe(provideHost);
                  return yield* ManagedGit.withManagedVerificationTarget(context, (target) =>
                    checkTarget(target).pipe(
                      Effect.andThen(
                        withProjectWorkVerificationExecutable(
                          instance.assets,
                          job.command.executable,
                          (fingerprint) =>
                            checkExecutable(fingerprint).pipe(
                              Effect.andThen(
                                Effect.gen(function* () {
                                  yield* grantCurrent(selection, "approved", "capture");
                                  const allocation = yield* preallocatePiManagedProcess({
                                    workspaceRoot: job.target.worktree,
                                    workspaceAccess: "readonly",
                                    protectedRoots: [...options.protectedRoots],
                                    runtimeFiles: instance.assets.runtimeFiles.map((file) => ({
                                      source: file.source,
                                      target: file.target,
                                    })),
                                    argv: [job.command.executable, ...job.command.argv],
                                    memoryBytes: 2147483648,
                                    runtimeSeconds: Math.ceil(
                                      job.command.limits.maxDurationMs / 1000,
                                    ),
                                  });
                                  const owned = { allocation, selection, revalidate };
                                  return yield* Effect.acquireUseRelease(
                                    Effect.suspend(() =>
                                      active.has(job.jobId)
                                        ? Effect.fail(
                                            denied("Verification host loan already active"),
                                          )
                                        : Effect.sync(() => {
                                            active.set(job.jobId, owned);
                                            return owned;
                                          }),
                                    ),
                                    () => use(allocation),
                                    () =>
                                      Effect.sync(() => {
                                        if (active.get(job.jobId) === owned)
                                          active.delete(job.jobId);
                                        for (const [attemptId, observation] of observations)
                                          if (
                                            observation.allocationHash ===
                                            verificationExecutionHash(allocation)
                                          )
                                            observations.delete(attemptId);
                                      }),
                                  );
                                }),
                              ),
                            ),
                        ),
                      ),
                    ),
                  );
                }),
              )
              .pipe(provideHost),
          );
        }),
      );
    const acquire = (claim: VerificationClaim, persistence: PiManagedProcessPersistence) =>
      boundary(
        Effect.gen(function* () {
          const owned = active.get(claim.intent.receipt.manifest.jobId);
          if (!owned || !same(owned.allocation, claim.intent.allocation))
            return yield* denied("Verification process has no current host loan");
          yield* grantCurrent(owned.selection, "consumed", claim.attemptId);
          yield* owned.revalidate;
          const launch = claim.intent.allocation.launch;
          const process = yield* acquirePiManagedProcess(
            {
              workspaceRoot: launch.workspaceRoot,
              workspaceAccess: "readonly",
              protectedRoots: launch.protectedRoots,
              runtimeFiles: launch.runtimeFiles.map((file) => ({
                source: file.source,
                target: file.target,
              })),
              argv: launch.argv,
              memoryBytes: launch.memoryBytes,
              runtimeSeconds: launch.runtimeSeconds,
            },
            persistence,
          ).pipe(
            Effect.mapError((error) => {
              if (isManagedProcessError(error) && error.phase === "startup") {
                if (error.message === "Original operation deadline cannot accommodate activation.")
                  return denied(
                    "Original verification deadline could not accommodate activation before native launch",
                  );
                if (error.message === "Managed owned service could not launch.")
                  return denied("Original verification launcher failed before owner capture");
              }
              return denied("Verification host evidence unavailable");
            }),
          );
          const observe = (drain: Effect.Success<typeof process.awaitExit>) =>
            Effect.sync(() => {
              observations.set(claim.attemptId, {
                kind: "drain",
                allocationHash: verificationExecutionHash(claim.intent.allocation),
                hash: verificationExecutionHash(drain),
              });
            });
          return {
            ...process,
            awaitExit: process.awaitExit.pipe(Effect.tap(observe)),
            stop: process.stop.pipe(Effect.tap(observe)),
          };
        }).pipe(provideHost),
      );
    const reconcile = (snapshot: VerificationExecutionSnapshot) =>
      boundary(
        reconcilePiManagedProcess(
          {
            allocation: snapshot.intent.allocation,
            activation:
              snapshot.phase === "claimed" ? "unlaunched" : snapshot.owner ? "owned" : "claimed",
            ...(snapshot.owner ? { owner: snapshot.owner } : {}),
          },
          { stop: true },
        ).pipe(
          provideHost,
          Effect.tap((receipt) =>
            Effect.sync(() => {
              observations.set(snapshot.attemptId, {
                kind: "reconciliation",
                allocationHash: verificationExecutionHash(snapshot.intent.allocation),
                hash: verificationExecutionHash({
                  unit: receipt.unit,
                  nonce: snapshot.intent.allocation.nonce,
                  kernel: receipt.kernel,
                }),
              });
            }),
          ),
        ),
      );
    const changes = yield* bus.subscribe;
    const settingChanges = yield* settings.subscribeChanges;
    const runtimeChanges = yield* pi.subscribeChanges;
    const authorityChanges = Stream.mergeAll({ concurrency: 3 })([
      changes.pipe(Stream.map(() => undefined)),
      settingChanges.pipe(Stream.map(() => undefined)),
      runtimeChanges.pipe(Stream.map(() => undefined)),
    ]);
    return {
      journal,
      assertEnabled,
      discover,
      withHost,
      acquire,
      reconcile,
      releaseRecoveryObservation: (snapshot: VerificationExecutionSnapshot) =>
        Effect.sync(() => {
          const observed = observations.get(snapshot.attemptId);
          if (observed?.allocationHash === verificationExecutionHash(snapshot.intent.allocation))
            observations.delete(snapshot.attemptId);
        }),
      authorityChanges,
      environmentSummary: (_intent: VerificationExecutionIntent) =>
        "linux clean environment; readonly original workspace; no network; 2 GiB memory",
    };
  },
  boundary,
);
