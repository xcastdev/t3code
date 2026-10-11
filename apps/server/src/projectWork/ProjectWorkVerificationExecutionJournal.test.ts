import { expect, it } from "@effect/vitest";
import {
  CommandId,
  canonicalProjectWorkPayload,
  ProjectWorkEvidenceAddCommand,
  ProjectTeamGate,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { scoped, at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { makeVerificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { makeProjectWorkVerificationExecutionGrant } from "./ProjectWorkVerificationExecutionGrant.ts";
import { makeProjectWorkVerificationGate } from "./ProjectWorkVerificationGate.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { prepareVerificationEvidence } from "./ProjectWorkVerificationEvidence.ts";
import {
  makeProjectWorkVerificationExecutionJournal,
  ProjectWorkVerificationExecutionError,
  verificationExecutionHash,
  type VerificationExecutionIntent,
  type VerificationClaim,
  type RetainedVerificationResult,
} from "./ProjectWorkVerificationExecutionJournal.ts";
import * as VerificationJournal from "./ProjectWorkVerificationExecutionJournal.ts";

const decodeGate = Schema.decodeUnknownSync(ProjectTeamGate);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const decodeEvidence = Schema.decodeUnknownEffect(ProjectWorkEvidenceAddCommand);
const attribution = {
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "verification-control" },
  recordedAt: at,
} as const;
const makeFixture = Effect.fn("makeExecutionJournalFixture")(function* (
  role: "implementer" | "integrator" = "implementer",
  retainTaskBudget = true,
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
  // Controlled custody fixture supplies the prior frozen task budget. Production
  // verification cannot originate or renew this budget when no Pi owner retained it.
  if (retainTaskBudget)
    yield* f.sql`INSERT INTO project_task_resource_budget VALUES('environment',${f.selection.projectId},${f.selection.taskId},${intent.deadlineAtMs + 300000},2147483648)`;
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

const fixture = makeFixture();

for (const phase of ["activating", "owner-captured"] as const) {
  it.effect("an ignored " + phase + " compare-and-swap cannot grant process permission", () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        if (phase === "owner-captured") yield* process.claimActivation(f.intent.allocation);
        if (phase === "activating")
          yield* f.sql`CREATE TRIGGER controlled_ignore_progress BEFORE UPDATE ON project_work_verification_execution WHEN NEW.phase='activating' BEGIN SELECT RAISE(IGNORE); END`;
        else
          yield* f.sql`CREATE TRIGGER controlled_ignore_progress BEFORE UPDATE ON project_work_verification_execution WHEN NEW.phase='owner-captured' BEGIN SELECT RAISE(IGNORE); END`;
        const permission =
          phase === "activating"
            ? process.claimActivation(f.intent.allocation)
            : process.beforeStart(f.owner);
        expect((yield* permission.pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* f.journal.readRecoveryPage({ limit: 1 })).items[0]).toMatchObject({
          phase: phase === "activating" ? "claimed" : "activating",
          owner: null,
        });
        yield* f.sql`DROP TRIGGER controlled_ignore_progress`;
        yield* permission;
      }),
    ),
  );
}

it.effect("a forged prepared digest cannot claim a retained approved job", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.journal
        .claim({ ...f.intent, receipt: { ...f.prepared, sha256: "0".repeat(64) } })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProjectWorkVerificationExecutionError" },
      });
      expect(yield* f.jobs.readPrepared(f.selection.jobId)).toEqual(f.prepared);
    }),
  ),
);

it.effect(
  "one atomic claim consumes the exact approved gate and duplicate callers cannot activate another allocation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const outcomes = yield* Effect.all([f.journal.claim(f.intent), f.journal.claim(f.intent)], {
          concurrency: "unbounded",
        });
        expect(outcomes.map((r) => r._tag).sort()).toEqual(["Active", "Claimed"]);
        const claimed = outcomes.find((r) => r._tag === "Claimed");
        if (claimed?._tag !== "Claimed") return yield* Effect.die("Missing claim");
        const state = yield* readCurrentState(f.sql, f.selection.projectId);
        expect(
          state.foundationRecords?.find((r) => r.recordId === f.intent.gate.recordId),
        ).toMatchObject({
          status: "consumed",
          consumedByRunId: claimed.claim.attemptId,
          attribution,
        });
        const persistence = f.journal.persistence(claimed.claim);
        yield* persistence.claimActivation(f.intent.allocation);
        expect(
          (yield* persistence.claimActivation(f.intent.allocation).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* persistence.beforeStart(f.owner);
        expect((yield* persistence.beforeStart(f.owner).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);

const claimed = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* () {
    const result = yield* f.journal.claim(f.intent);
    if (result._tag !== "Claimed") return yield* Effect.die("Expected new exact claim");
    return result.claim;
  });

it.effect(
  "managed persistence captures only its original SQL service and fences a foreign caller client",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        expect(
          (yield* process
            .claimActivation(f.intent.allocation)
            .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql }), Effect.result))._tag,
        ).toBe("Failure");
        yield* process
          .claimActivation(f.intent.allocation)
          .pipe(Effect.provideContext(Context.empty()));
        yield* process.beforeStart(f.owner).pipe(Effect.provideContext(Context.empty()));
        expect((yield* f.journal.readRecoveryPage({ limit: 1 })).items[0]).toMatchObject({
          phase: "owner-captured",
          owner: f.owner,
        });
      }),
    ),
);
const retainedResult = (
  f: Effect.Success<typeof fixture>,
  claim: VerificationClaim,
  outcome: RetainedVerificationResult["outcome"] = "success",
) =>
  Effect.gen(function* () {
    const store = yield* makeProjectWorkArtifacts({
      environmentId: "environment",
      maximumArtifactBytes: 4096,
    });
    const job = claim.intent.receipt.manifest;
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
      exitCode: 0,
      environmentSummary: "controlled-linux clean readonly",
      integration: job.integration === true,
    };
    const stdout = yield* store.retain({
      artifactId: claim.attemptId + ":stdout",
      sourceId: claim.attemptId,
      applicability,
      bytes: new Uint8Array([0, 255, 10]),
    });
    const stderr = yield* store.retain({
      artifactId: claim.attemptId + ":stderr",
      sourceId: claim.attemptId,
      applicability,
      bytes: new Uint8Array([27, 0]),
    });
    return {
      store,
      result: {
        version: 1 as const,
        jobId: job.jobId,
        attemptId: claim.attemptId,
        manifestHash: claim.intent.receipt.sha256,
        allocationHash: verificationExecutionHash(claim.intent.allocation),
        outcome,
        exitCode: 0,
        outputComplete: true,
        stdout,
        stderr,
        drain: f.drain,
        drainHash: verificationExecutionHash(f.drain),
        environmentSummary: applicability.environmentSummary,
        finishedAtMs: yield* Clock.currentTimeMillis,
      },
    };
  });

const makeObservedFixture = Effect.fn("makeObservedFixture")(function* (
  role: "implementer" | "integrator" = "implementer",
) {
  const f = yield* makeFixture(role);
  const bus = yield* ProjectWorkEventBus.pipe(Effect.provide(ProjectWorkEventBusLive));
  let publications = 0;
  const repository = yield* ProjectWorkRepository.pipe(
    Effect.provide(Layer.fresh(ProjectWorkRepositoryLive)),
    Effect.provideService(ProjectWorkEventBus, {
      ...bus,
      publish: (events) =>
        Effect.sync(() => {
          publications += events.length;
        }),
    }),
  );
  const journal = yield* makeProjectWorkVerificationExecutionJournal(f.options).pipe(
    Effect.provideService(ProjectWorkRepository, repository),
  );
  return { ...f, journal, repository, publications: () => publications };
});

const observedFixture = makeObservedFixture();

it.effect(
  "the historical result reader composes in its captured transaction after grant revocation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        yield* process.claimActivation(f.intent.allocation);
        yield* process.beforeStart(f.owner);
        const { result } = yield* retainedResult(f, claim);
        yield* f.journal.complete(claim, result);
        f.revoke();
        const reader = yield* VerificationJournal.makeProjectWorkVerificationResultReader({
          environmentId: "environment",
        });
        const input = { jobId: f.selection.jobId, expectedManifestHash: f.prepared.sha256 };
        const historical = yield* f.sql.withTransaction(reader.readInTransaction(input));
        expect(historical._tag).toBe("Terminal");
        if (historical._tag !== "Terminal")
          return yield* Effect.die("Expected retained terminal result");
        expect(historical.result).toEqual(result);
        expect(historical.snapshot.intent).toEqual(f.intent);
        expect(historical.snapshot.owner).toEqual(f.owner);
        expect(historical.metadata.manifestHash).toBe(f.prepared.sha256);
        expect(historical.metadata.resultHash).toBe(verificationExecutionHash(result));
        expect(Object.isFrozen(historical.snapshot)).toBe(true);
        expect(yield* f.journal.readResult(f.selection.jobId)).toEqual(result);
        expect((yield* reader.readInTransaction(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(f.journal.readResult(f.selection.jobId))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "the historical result reader preserves missing and pending history without recovery authority",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const repository = yield* ProjectWorkRepository;
        const reader = yield* VerificationJournal.makeProjectWorkVerificationResultReader({
          environmentId: "environment",
        });
        const input = { jobId: f.selection.jobId, expectedManifestHash: f.prepared.sha256 };
        expect(yield* f.sql.withTransaction(reader.readInTransaction(input))).toEqual({
          _tag: "Missing",
        });
        const claim = yield* claimed(f);
        const pending = yield* f.sql.withTransaction(reader.readInTransaction(input));
        expect(pending._tag).toBe("Pending");
        if (pending._tag !== "Pending")
          return yield* Effect.die("Expected original pending attempt");
        expect(pending.snapshot.phase).toBe("claimed");
        expect(pending.snapshot.result).toBeNull();
        expect(
          (yield* f.journal
            .quarantineRecovery(pending.snapshot, "foreign recovery")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              reader
                .readInTransaction(input)
                .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              reader
                .readInTransaction(input)
                .pipe(Effect.provideService(ProjectWorkRepository, { ...repository })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              reader
                .readInTransaction(input)
                .pipe(Effect.updateContext<never, never>(() => Context.empty())),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              reader.readInTransaction({ ...input, expectedManifestHash: "f".repeat(64) }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const mutable = { ...input };
        const captured = reader.readInTransaction(mutable);
        mutable.jobId = "different-job";
        mutable.expectedManifestHash = "f".repeat(64);
        expect((yield* f.sql.withTransaction(captured))._tag).toBe("Pending");
        yield* f.journal.recordUncertain(claim, "Controlled uncertainty");
        const quarantined = yield* f.sql.withTransaction(reader.readInTransaction(input));
        expect(quarantined._tag).toBe("Pending");
        if (quarantined._tag === "Pending") expect(quarantined.snapshot.phase).toBe("quarantine");
        const excess = { ...input, extra: true };
        expect((yield* reader.readInTransaction(excess).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);

for (const channel of ["stdout", "stderr"] as const)
  it.effect(
    `the historical result reader rehashes retained ${channel} bytes and propagates unavailable storage`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const claim = yield* claimed(f);
          yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
          yield* f.journal.persistence(claim).beforeStart(f.owner);
          const { result } = yield* retainedResult(f, claim, "failed");
          yield* f.journal.complete(claim, result);
          const reader = yield* VerificationJournal.makeProjectWorkVerificationResultReader({
            environmentId: "environment",
          });
          const input = { jobId: f.selection.jobId, expectedManifestHash: f.prepared.sha256 };
          const failed = yield* f.sql.withTransaction(reader.readInTransaction(input));
          expect(failed._tag).toBe("Terminal");
          if (failed._tag === "Terminal") expect(failed.result.outcome).toBe("failed");
          yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
          const changed =
            channel === "stdout" ? new Uint8Array([1, 255, 10]) : new Uint8Array([27, 1]);
          yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=${changed} WHERE artifact_id=${result[channel].artifactId}`;
          const corrupted = yield* f.sql
            .withTransaction(reader.readInTransaction(input))
            .pipe(Effect.result);
          expect(corrupted._tag).toBe("Failure");
          if (corrupted._tag === "Failure")
            expect(corrupted.failure).toMatchObject({
              reason: "Retained verification bytes or manifest changed",
            });
          expect((yield* f.journal.readResult(f.selection.jobId).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          yield* f.sql`ALTER TABLE project_work_artifacts RENAME TO controlled_unavailable_artifacts`;
          const unavailable = yield* f.sql
            .withTransaction(reader.readInTransaction(input))
            .pipe(Effect.exit);
          expect(unavailable._tag).toBe("Failure");
          if (unavailable._tag === "Failure")
            expect(Cause.pretty(unavailable.cause)).toContain("no such table");
        }),
      ),
  );

it.effect("a borrowed historical result cannot escape the owning repository's failed COMMIT", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const repository = yield* ProjectWorkRepository;
      const claim = yield* claimed(f);
      yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
      yield* f.journal.persistence(claim).beforeStart(f.owner);
      const { result } = yield* retainedResult(f, claim);
      yield* f.journal.complete(claim, result);
      const reader = yield* VerificationJournal.makeProjectWorkVerificationResultReader({
        environmentId: "environment",
      });
      const input = { jobId: f.selection.jobId, expectedManifestHash: f.prepared.sha256 };
      yield* f.sql`CREATE TABLE controlled_historical_parent(id INTEGER PRIMARY KEY)`;
      yield* f.sql`CREATE TABLE controlled_historical_child(parent_id INTEGER REFERENCES controlled_historical_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      let insideTerminal = false;
      const failed = yield* repository
        .executeAtomic(
          Effect.gen(function* () {
            const historical = yield* reader.readInTransaction(input);
            insideTerminal = historical._tag === "Terminal";
            yield* f.sql`INSERT INTO controlled_historical_child(parent_id) VALUES(1)`;
            return [];
          }),
          reader.readInTransaction(input).pipe(Effect.asVoid),
        )
        .pipe(Effect.exit);
      expect(insideTerminal).toBe(true);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure")
        expect(Cause.pretty(failed.cause)).toContain("FOREIGN KEY constraint failed");
      // The owning connection rescues its failed COMMIT before releasing it.
      expect((yield* f.sql.withTransaction(reader.readInTransaction(input)))._tag).toBe("Terminal");
      expect(yield* f.sql`SELECT COUNT(*) AS escaped FROM controlled_historical_child`).toEqual([
        { escaped: 0 },
      ]);
      expect(yield* f.journal.readResult(f.selection.jobId)).toEqual(result);
    }),
  ),
);

for (const corruption of ["manifest", "owner", "drain", "malformed-result"] as const)
  it.effect(
    `the historical result reader propagates corrupt ${corruption} identity instead of missing history`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const claim = yield* claimed(f);
          yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
          yield* f.journal.persistence(claim).beforeStart(f.owner);
          const { result } = yield* retainedResult(f, claim);
          yield* f.journal.complete(claim, result);
          const reader = yield* VerificationJournal.makeProjectWorkVerificationResultReader({
            environmentId: "environment",
          });
          const input = { jobId: f.selection.jobId, expectedManifestHash: f.prepared.sha256 };
          yield* f.sql`DROP TRIGGER project_work_verification_execution_progress`;
          yield* f.sql`DROP TRIGGER project_work_verification_execution_intent_immutable`;
          if (corruption === "manifest")
            yield* f.sql`UPDATE project_work_verification_execution SET manifest_hash=${"f".repeat(64)}`;
          else if (corruption === "owner")
            yield* f.sql`UPDATE project_work_verification_execution SET owner_json=${canonicalProjectWorkPayload({ ...f.owner, invocation: "b".repeat(32) })}`;
          else if (corruption === "drain") {
            const changedDrain = { ...f.drain, childExitCode: 1 };
            const changed = {
              ...result,
              exitCode: 1,
              drain: changedDrain,
              drainHash: verificationExecutionHash(changedDrain),
            };
            yield* f.sql`UPDATE project_work_verification_execution SET result_json=${canonicalProjectWorkPayload(changed)},result_hash=${verificationExecutionHash(changed)}`;
          } else yield* f.sql`UPDATE project_work_verification_execution SET result_json='{}'`;
          expect(
            (yield* f.sql.withTransaction(reader.readInTransaction(input)).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect((yield* f.journal.readResult(f.selection.jobId).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        }),
      ),
  );

it.effect(
  "a drained result retains exact binary artifacts and immutable retries never replace its winner",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        yield* process.claimActivation(f.intent.allocation);
        yield* process.beforeStart(f.owner);
        const { result, store } = yield* retainedResult(f, claim);
        const before = yield* readCurrentState(f.sql, f.selection.projectId);
        expect(yield* f.journal.complete(claim, result)).toEqual(result);
        const completed = yield* readCurrentState(f.sql, f.selection.projectId);
        const evidence = completed.evidence.filter((e) => e.kind === "test");
        expect(evidence).toHaveLength(1);
        expect(evidence[0]).toMatchObject({
          taskId: f.selection.taskId,
          outputArtifactIds: [result.stdout.artifactId, result.stderr.artifactId],
          scopeHash: projectTeamScopeHash(
            before,
            f.selection.taskId,
            before.foundationRecords?.find((r) => r.kind === "plan-revision"),
          ),
        });
        expect(
          completed.foundationRecords?.filter((r) => r.kind === "evidence-applicability"),
        ).toMatchObject([
          {
            evidenceId: evidence[0]!.evidenceId,
            taskId: f.selection.taskId,
            status: "current",
            integration: false,
            artifactId: result.stdout.artifactId,
            testedCommit: f.prepared.manifest.target.testedCommit,
            specRevision: f.prepared.manifest.specRevision,
            planRevision: f.prepared.manifest.planRevision,
            repository: "/workspace",
            worktree: "/workspace-assigned",
            testedTree: "d".repeat(40),
            baseSha: "a".repeat(40),
            headSha: "c".repeat(40),
            command: '{"argv":["-n","test.sh"],"executable":"/bin/bash"}',
            exitCode: 0,
            environmentSummary: "controlled-linux clean readonly",
          },
        ]);
        expect(completed.criteria).toEqual(before.criteria);
        expect(yield* f.journal.readResult(f.selection.jobId)).toEqual(result);
        expect((yield* store.readRetained(result.stdout.artifactId))?.bytes).toEqual(
          new Uint8Array([0, 255, 10]),
        );
        expect(yield* f.journal.complete(claim, result)).toEqual(result);
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(completed);
        expect(
          (yield* f.journal.complete(claim, { ...result, outcome: "failed" }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(yield* f.journal.claim(f.intent)).toEqual({ _tag: "Retained", result });
      }),
    ),
);

it.effect(
  "claim snapshots selection synchronously and foreign journal receipts cannot activate it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const cloned = structuredClone(f.intent);
        const input = {
          ...cloned,
          gate: { ...cloned.gate },
          receipt: {
            ...cloned.receipt,
            manifest: {
              ...cloned.receipt.manifest,
              command: {
                ...cloned.receipt.manifest.command,
                argv: [...cloned.receipt.manifest.command.argv],
              },
            },
          },
        };
        const request = f.journal.claim(input);
        input.receipt.manifest.command.argv.push("replaced after construction");
        input.gate.contentHash = "0".repeat(64);
        const result = yield* request;
        if (result._tag !== "Claimed") return yield* Effect.die("Missing captured claim");
        expect(result.claim.intent.receipt.manifest.command.argv).toEqual(["-n", "test.sh"]);
        const foreign = yield* makeProjectWorkVerificationExecutionJournal(f.options);
        expect(
          (yield* foreign
            .persistence(result.claim)
            .claimActivation(f.intent.allocation)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.journal
            .persistence({ ...result.claim })
            .claimActivation(f.intent.allocation)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.journal.persistence(result.claim).claimActivation(f.intent.allocation);
      }),
    ),
);

it.effect(
  "failed consumed-gate validation rolls back claim and approval together, allowing an exact retry",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        let fail = true;
        const journal = yield* makeProjectWorkVerificationExecutionJournal({
          ...f.options,
          assertCurrent: (intent, state, phase, id) =>
            phase === "consumed" && fail
              ? Effect.fail(
                  new ProjectWorkVerificationExecutionError({ reason: "Held final validation" }),
                )
              : f.options.assertCurrent(intent, state, phase, id),
        });
        expect((yield* journal.claim(f.intent).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* readCurrentState(f.sql, f.selection.projectId)).foundationRecords?.find(
            (r) => r.recordId === f.intent.gate.recordId,
          )?.status,
        ).toBe("approved");
        expect((yield* journal.readRecoveryPage({ limit: 1 })).items).toEqual([]);
        fail = false;
        expect((yield* journal.claim(f.intent))._tag).toBe("Claimed");
      }),
    ),
);

it.effect("retained success loses validity when its physical owner is missing", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claim = yield* claimed(f);
      const process = f.journal.persistence(claim);
      yield* process.claimActivation(f.intent.allocation);
      yield* process.beforeStart(f.owner);
      const { result } = yield* retainedResult(f, claim);
      yield* f.journal.complete(claim, result);
      // Disposable corruption control bypasses only the immutable-winner trigger.
      yield* f.sql`DROP TRIGGER project_work_verification_execution_progress`;
      yield* f.sql`UPDATE project_work_verification_execution SET owner_json=NULL`;
      expect((yield* f.journal.readResult(f.selection.jobId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* f.journal.claim(f.intent).pipe(Effect.result))._tag).toBe("Failure");
    }),
  ),
);

it.effect("a held owner callback rereads revoked authority before committing the owner", () =>
  scoped(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let held = false;
        const journal = yield* makeProjectWorkVerificationExecutionJournal({
          ...f.options,
          assertCurrent: (intent, state, phase, id) =>
            Effect.gen(function* () {
              if (held) {
                held = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              yield* f.options.assertCurrent(intent, state, phase, id);
            }),
        });
        const outcome = yield* journal.claim(f.intent);
        if (outcome._tag !== "Claimed") return yield* Effect.die("Missing claim");
        const process = journal.persistence(outcome.claim);
        yield* process.claimActivation(f.intent.allocation);
        held = true;
        const starting = yield* process.beforeStart(f.owner).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        f.revoke();
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.await(starting))._tag).toBe("Failure");
        expect((yield* journal.readRecoveryPage({ limit: 1 })).items[0]).toMatchObject({
          phase: "activating",
          owner: null,
        });
        yield* journal.recordUncertain(outcome.claim, "Grant revoked before captured owner");
      }),
    ),
  ),
);

it.effect(
  "result submission captures caller bytes and rejects changed owner, channel, and provenance",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        yield* process.claimActivation(f.intent.allocation);
        yield* process.beforeStart(f.owner);
        const { result } = yield* retainedResult(f, claim);
        for (const changed of [
          { ...result, drain: { ...result.drain, ownerPid: 201 } },
          { ...result, stderr: result.stdout },
          { ...result, stdout: { ...result.stdout, sourceId: "foreign-attempt" } },
          { ...result, allocationHash: "0".repeat(64) },
          { ...result, outputComplete: false },
        ])
          expect((yield* f.journal.complete(claim, changed).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        const input = structuredClone(result);
        const submitted = f.journal.complete(claim, input);
        input.environmentSummary = "caller changed";
        input.stdout.sha256 = "0".repeat(64);
        expect(yield* submitted).toEqual(result);
      }),
    ),
);

it.effect("journal operations refuse inherited SQL transactions without consuming approval", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        (yield* f.sql.withTransaction(f.journal.claim(f.intent)).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql.withTransaction(f.journal.readResult(f.selection.jobId)).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* readCurrentState(f.sql, f.selection.projectId)).foundationRecords?.find(
          (r) => r.recordId === f.intent.gate.recordId,
        )?.status,
      ).toBe("approved");
      expect((yield* f.journal.claim(f.intent))._tag).toBe("Claimed");
    }),
  ),
);

for (const role of ["implementer", "integrator"] as const)
  it.effect(
    `failed ${role} result COMMIT cannot expose a physically pending terminal row and exact retry preserves artifacts`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeObservedFixture(role);
          const claim = yield* claimed(f);
          const process = f.journal.persistence(claim);
          yield* process.claimActivation(f.intent.allocation);
          yield* process.beforeStart(f.owner);
          const { result, store } = yield* retainedResult(f, claim);
          const before = yield* readCurrentState(f.sql, f.selection.projectId);
          const publications = f.publications();
          yield* f.sql`PRAGMA foreign_keys=ON`;
          yield* f.sql`CREATE TABLE controlled_parent(id INTEGER PRIMARY KEY)`;
          yield* f.sql`CREATE TABLE controlled_child(parent_id INTEGER REFERENCES controlled_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
          yield* f.sql`CREATE TRIGGER controlled_commit_failure AFTER UPDATE ON project_work_verification_execution WHEN NEW.phase='terminal' BEGIN INSERT INTO controlled_child(parent_id) VALUES(1); END`;
          const completed = yield* f.journal.complete(claim, result).pipe(Effect.exit);
          expect(completed._tag).toBe("Failure");
          expect(f.publications()).toBe(publications);
          if (completed._tag === "Failure")
            expect(Cause.pretty(completed.cause)).toContain("FOREIGN KEY constraint failed");
          expect(yield* f.sql`SELECT phase FROM project_work_verification_execution`).toEqual([
            { phase: "owner-captured" },
          ]);
          expect(
            yield* f.sql`SELECT COUNT(*) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
          ).toEqual([{ held: 1 }]);
          expect((yield* f.journal.readRecoveryPage({ limit: 1 })).items[0]?.phase).toBe(
            "owner-captured",
          );
          const query = yield* ProjectWorkQuery;
          expect(
            (yield* query.exportSnapshot(f.selection.projectId, false, true)).snapshot.evidence,
          ).toEqual(before.evidence);
          expect(
            (yield* query.withProjectRevision(
              f.selection.projectId,
              query.listEvidence({
                projectId: f.selection.projectId,
                taskId: f.selection.taskId,
                limit: 50,
              }),
            )).value,
          ).toEqual([]);
          expect(yield* f.journal.readResult(f.selection.jobId)).toBeUndefined();
          expect((yield* query.snapshot(f.selection.projectId)).evidence).toEqual(before.evidence);
          expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(before);
          yield* f.sql`DROP TRIGGER controlled_commit_failure`;
          expect(yield* f.journal.complete(claim, result)).toEqual(result);
          expect(f.publications()).toBe(publications + 2);
          expect((yield* store.readRetained(result.stdout.artifactId))?.bytes).toEqual(
            new Uint8Array([0, 255, 10]),
          );
        }),
      ),
  );

it.effect("recovery snapshots grant only same-journal cleanup and never forward success", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claim = yield* claimed(f);
      const snapshot = (yield* f.journal.readRecoveryPage({ limit: 1 })).items[0]!;
      const foreign = yield* makeProjectWorkVerificationExecutionJournal(f.options);
      expect(
        (yield* foreign.quarantineRecovery(snapshot, "Foreign cleanup").pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.journal.quarantineRecovery({ ...snapshot }, "Copied cleanup").pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      const { result } = yield* retainedResult(f, claim);
      expect((yield* f.journal.finishRecovery(snapshot, result).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* f.journal.quarantineRecovery(snapshot, "Original ownership uncertain");
      expect(yield* f.journal.claim(f.intent)).toEqual({
        _tag: "Uncertain",
        reason: "Original ownership uncertain",
      });
      expect(
        (yield* f.journal
          .persistence(claim)
          .claimActivation(f.intent.allocation)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("retained artifacts alone cannot bypass the host's actual result observation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let observed = false;
      const journal = yield* makeProjectWorkVerificationExecutionJournal({
        ...f.options,
        verifyResult: () =>
          observed
            ? Effect.void
            : Effect.fail(
                new ProjectWorkVerificationExecutionError({ reason: "No host observation" }),
              ),
      });
      const outcome = yield* journal.claim(f.intent);
      if (outcome._tag !== "Claimed") return yield* Effect.die("Missing claim");
      const process = journal.persistence(outcome.claim);
      yield* process.claimActivation(f.intent.allocation);
      yield* process.beforeStart(f.owner);
      const { result } = yield* retainedResult(f, outcome.claim);
      expect((yield* journal.complete(outcome.claim, result).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* journal.readResult(f.selection.jobId)).toBeUndefined();
      expect((yield* readCurrentState(f.sql, f.selection.projectId)).evidence).toEqual([]);
      expect((yield* journal.readRecoveryPage({ limit: 1 })).items[0]?.phase).toBe(
        "owner-captured",
      );
      observed = true;
      expect(yield* journal.complete(outcome.claim, result)).toEqual(result);
    }),
  ),
);

for (const outcome of [
  "failed",
  "timed-out",
  "overflow",
  "canceled",
  "revoked",
  "abandoned",
] as const)
  it.effect(`${outcome} completion retains history without current test evidence`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
        yield* f.journal.persistence(claim).beforeStart(f.owner);
        const { result } = yield* retainedResult(f, claim, outcome);
        const before = yield* readCurrentState(f.sql, f.selection.projectId);
        yield* f.journal.complete(claim, result);
        expect(yield* f.journal.readResult(f.selection.jobId)).toEqual(result);
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(before);
      }),
    ),
  );

it.effect("historical terminal success cannot backfill evidence after restart or retry", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claim = yield* claimed(f);
      yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
      yield* f.journal.persistence(claim).beforeStart(f.owner);
      const { result } = yield* retainedResult(f, claim);
      const before = yield* readCurrentState(f.sql, f.selection.projectId);
      // Restore the older terminal-only format in a disposable migrated database.
      yield* f.sql`UPDATE project_work_verification_execution SET phase='terminal', result_json=${canonicalProjectWorkPayload(result)}, result_hash=${verificationExecutionHash(result)}, revision=revision+1`;
      const restarted = yield* makeProjectWorkVerificationExecutionJournal(f.options);
      expect(yield* restarted.readResult(f.selection.jobId)).toEqual(result);
      expect(yield* restarted.claim(f.intent)).toEqual({ _tag: "Retained", result });
      expect(yield* f.journal.complete(claim, result)).toEqual(result);
      expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(before);
    }),
  ),
);

it.effect("terminal success retries cannot restore evidence that was subsequently made stale", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* observedFixture;
      const claim = yield* claimed(f);
      yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
      yield* f.journal.persistence(claim).beforeStart(f.owner);
      const { result } = yield* retainedResult(f, claim);
      yield* f.journal.complete(claim, result);
      const state = yield* readCurrentState(f.sql, f.selection.projectId);
      const record = state.foundationRecords?.find((r) => r.kind === "evidence-applicability");
      if (record?.kind !== "evidence-applicability") return yield* Effect.die("Missing evidence");
      yield* f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId: state.projectId,
          commandId: "stale-verification-evidence",
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [{ ...record, status: "stale", revision: record.revision + 1 }],
        }),
      );
      const stale = yield* readCurrentState(f.sql, f.selection.projectId);
      const publications = f.publications();
      expect(yield* f.journal.complete(claim, result)).toEqual(result);
      const restarted = yield* makeProjectWorkVerificationExecutionJournal(f.options);
      expect(yield* restarted.readResult(f.selection.jobId)).toEqual(result);
      expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(stale);
      expect(f.publications()).toBe(publications);
    }),
  ),
);

for (const failure of ["projection", "final-host", "final-grant", "artifact-corruption"] as const)
  it.effect(`${failure} failure cannot escape a terminal result, evidence, or publication`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* observedFixture;
        let observations = 0;
        const journal = yield* makeProjectWorkVerificationExecutionJournal({
          ...f.options,
          verifyResult: () =>
            Effect.gen(function* () {
              observations++;
              if (failure === "final-host" && observations === 2)
                return yield* new ProjectWorkVerificationExecutionError({
                  reason: "Host target changed",
                });
              if (failure === "final-grant" && observations === 2) f.revoke();
            }),
        }).pipe(Effect.provideService(ProjectWorkRepository, f.repository));
        const claimedResult = yield* journal.claim(f.intent);
        if (claimedResult._tag !== "Claimed") return yield* Effect.die("Missing claim");
        const claim = claimedResult.claim;
        yield* journal.persistence(claim).claimActivation(f.intent.allocation);
        yield* journal.persistence(claim).beforeStart(f.owner);
        const { result } = yield* retainedResult(f, claim);
        const before = yield* readCurrentState(f.sql, f.selection.projectId);
        const publications = f.publications();
        if (failure === "projection")
          yield* f.sql`CREATE TRIGGER reject_verification_evidence BEFORE INSERT ON project_work_evidence WHEN NEW.kind='test' BEGIN SELECT RAISE(ABORT,'controlled evidence failure'); END`;
        if (failure === "artifact-corruption") {
          yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
          yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=X'000000' WHERE artifact_id=${result.stdout.artifactId}`;
        }
        expect((yield* journal.complete(claim, result).pipe(Effect.exit))._tag).toBe("Failure");
        expect(f.publications()).toBe(publications);
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(before);
        expect((yield* journal.readRecoveryPage({ limit: 1 })).items[0]?.phase).toBe(
          "owner-captured",
        );
        if (failure !== "artifact-corruption")
          expect(yield* journal.readResult(f.selection.jobId)).toBeUndefined();
        if (failure === "projection") {
          yield* f.sql`DROP TRIGGER reject_verification_evidence`;
          expect(yield* journal.complete(claim, result)).toEqual(result);
          expect(f.publications()).toBe(publications + 2);
        }
      }),
    ),
  );

for (const collision of ["evidence", "applicability", "command"] as const)
  it.effect(
    `${collision} identity conflicts deny completion without replacing existing records`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* observedFixture;
          const claim = yield* claimed(f);
          yield* f.journal.persistence(claim).claimActivation(f.intent.allocation);
          yield* f.journal.persistence(claim).beforeStart(f.owner);
          const { result } = yield* retainedResult(f, claim);
          const prepared = prepareVerificationEvidence(
            yield* readCurrentState(f.sql, f.selection.projectId),
            f.intent,
            result,
          );
          if (collision === "applicability") {
            const record = prepared.applicability.records[0];
            yield* f.repository.execute(
              decodeCommit({
                ...prepared.applicability,
                commandId: "seed-applicability-collision",
                expectedRevision: prepared.evidence.expectedRevision,
                records: [{ ...record, environmentSummary: "different recorded environment" }],
              }),
            );
          } else {
            yield* f.repository.execute(
              yield* decodeEvidence({
                ...prepared.evidence,
                commandId:
                  collision === "command" ? prepared.evidence.commandId : "seed-evidence-collision",
                evidence: {
                  ...prepared.evidence.evidence,
                  summary: "Different original evidence",
                  ...(collision === "command" ? { evidenceId: "different-evidence" } : {}),
                },
              }),
            );
          }
          const before = yield* readCurrentState(f.sql, f.selection.projectId);
          const publications = f.publications();
          expect((yield* f.journal.complete(claim, result).pipe(Effect.exit))._tag).toBe("Failure");
          expect(yield* f.journal.readResult(f.selection.jobId)).toBeUndefined();
          expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(before);
          expect(f.publications()).toBe(publications);
        }),
      ),
  );

it.effect(
  "original integrator terminal history rehashes both outputs and rejects classification downgrade",
  () =>
    scoped(
      Effect.gen(function* () {
        const initial = yield* makeFixture("integrator");
        let enabled = true;
        const grant = yield* makeProjectWorkVerificationExecutionGrant({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          assertEnabled: Effect.suspend(() =>
            enabled
              ? Effect.void
              : Effect.fail(
                  new ProjectWorkVerificationExecutionError({
                    reason: "Controlled disabled project",
                  }),
                ),
          ),
        });
        const journal = yield* makeProjectWorkVerificationExecutionJournal({
          ...initial.options,
          assertCurrent: grant.assertCurrent,
          consumeApproval: grant.consumeApproval,
        });
        const f = { ...initial, journal };
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        yield* process.claimActivation(f.intent.allocation);
        yield* process.beforeStart(f.owner);
        const { result, store } = yield* retainedResult(f, claim);
        yield* f.journal.complete(claim, result);
        const completed = yield* readCurrentState(f.sql, f.selection.projectId);
        expect(
          completed.foundationRecords?.find((row) => row.kind === "evidence-applicability"),
        ).toMatchObject({ integration: true, status: "current" });
        expect(completed.tasks.find((row) => row.taskId === f.selection.taskId)?.state).not.toBe(
          "completed",
        );
        enabled = false;
        const reader = yield* VerificationJournal.makeProjectWorkVerificationResultReader({
          environmentId: "environment",
        });
        const input = { jobId: f.selection.jobId, expectedManifestHash: f.prepared.sha256 };
        const historical = yield* f.sql.withTransaction(reader.readInTransaction(input));
        expect(historical).toMatchObject({
          _tag: "Terminal",
          result,
          snapshot: {
            intent: { receipt: { manifest: { integration: true } } },
            owner: f.owner,
          },
        });
        const prior = yield* f.journal.readResult(f.selection.jobId);
        expect(prior).toEqual(result);
        expect((yield* f.journal.claim(f.intent))._tag).toBe("Retained");
        yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
        for (const output of [result.stdout, result.stderr]) {
          const artifact = yield* store.readRetained(output.artifactId);
          if (!artifact) return yield* Effect.die("Missing retained output");
          expect(artifact.applicability.integration).toBe(true);
          const original = canonicalProjectWorkPayload({
            artifactId: artifact.artifactId,
            sourceId: artifact.sourceId,
            applicability: artifact.applicability,
          });
          const downgraded = canonicalProjectWorkPayload({
            artifactId: artifact.artifactId,
            sourceId: artifact.sourceId,
            applicability: { ...artifact.applicability, integration: false },
          });
          yield* f.sql`UPDATE project_work_artifacts SET manifest_json=${downgraded} WHERE artifact_id=${output.artifactId}`;
          expect((yield* f.journal.readResult(f.selection.jobId).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(
            (yield* f.sql.withTransaction(reader.readInTransaction(input)).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          yield* f.sql`UPDATE project_work_artifacts SET manifest_json=${original} WHERE artifact_id=${output.artifactId}`;
        }
        expect(yield* f.journal.readResult(f.selection.jobId)).toEqual(result);
      }),
    ),
);

it.effect(
  "task resources consume approved verification and retain failed drain before matching recovery",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const persistence = f.journal.persistence(claim);
        yield* persistence.claimActivation(f.intent.allocation);
        yield* persistence.beforeStart(f.owner);
        if (!persistence.afterDrain)
          return yield* Effect.die("Missing verification resource drain");
        expect(
          (yield* persistence
            .afterDrain({ ...f.drain, invocation: "b".repeat(32) })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: f.intent.allocation.policy.memoryBytes }]);
        yield* persistence.afterDrain(f.drain);
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(f.drain) },
        ]);
        expect(
          (yield* persistence.claimActivation(f.intent.allocation).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect("task resources deny approved verification without an original same-task budget", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture("implementer", false);
      const claim = yield* claimed(f);
      expect(
        (yield* f.journal
          .persistence(claim)
          .claimActivation(f.intent.allocation)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT unit FROM project_task_resource_child`).toEqual([]);
      expect((yield* f.journal.readRecoveryPage({ limit: 1 })).items[0]?.phase).toBe("claimed");
    }),
  ),
);

it.effect(
  "task resources release only exact actual verification recovery observations after expiry",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        yield* process.claimActivation(f.intent.allocation);
        yield* process.beforeStart(f.owner);
        yield* TestClock.setTime(f.intent.deadlineAtMs + 1);
        const snapshot = (yield* f.journal.readRecoveryPage({ limit: 1 })).items[0];
        if (!snapshot) return yield* Effect.die("Missing original verification recovery");
        const actual = {
          state: "drained" as const,
          unit: f.owner.unit,
          invocation: f.owner.invocation,
          cgroup: f.owner.cgroup,
          kernel: "removed",
        };
        expect(
          (yield* f.journal
            .persistReconciliation(snapshot, { ...actual, invocation: "b".repeat(32) })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: f.intent.allocation.policy.memoryBytes }]);
        yield* f.journal.persistReconciliation(snapshot, actual);
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(actual) },
        ]);
        yield* f.journal.persistReconciliation(snapshot, actual);
      }),
    ),
);
