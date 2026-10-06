import { expect, it } from "@effect/vitest";
import {
  CommandId,
  canonicalProjectWorkPayload,
  ProjectTeamGate,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { scoped, at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectWorkVerificationGate } from "./ProjectWorkVerificationGate.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import {
  makeProjectWorkVerificationExecutionJournal,
  ProjectWorkVerificationExecutionError,
  verificationExecutionHash,
  type VerificationExecutionIntent,
  type VerificationClaim,
  type RetainedVerificationResult,
} from "./ProjectWorkVerificationExecutionJournal.ts";

const decodeGate = Schema.decodeUnknownSync(ProjectTeamGate);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const attribution = {
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "verification-control" },
  recordedAt: at,
} as const;
const fixture = Effect.gen(function* () {
  const f = yield* verificationFixture;
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
      integration: false,
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
        expect(yield* f.journal.complete(claim, result)).toEqual(result);
        expect(yield* f.journal.readResult(f.selection.jobId)).toEqual(result);
        expect((yield* store.readRetained(result.stdout.artifactId))?.bytes).toEqual(
          new Uint8Array([0, 255, 10]),
        );
        expect(yield* f.journal.complete(claim, result)).toEqual(result);
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

it.effect(
  "failed result COMMIT cannot expose a physically pending terminal row and exact retry preserves artifacts",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claim = yield* claimed(f);
        const process = f.journal.persistence(claim);
        yield* process.claimActivation(f.intent.allocation);
        yield* process.beforeStart(f.owner);
        const { result, store } = yield* retainedResult(f, claim);
        yield* f.sql`PRAGMA foreign_keys=ON`;
        yield* f.sql`CREATE TABLE controlled_parent(id INTEGER PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE controlled_child(parent_id INTEGER REFERENCES controlled_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER controlled_commit_failure AFTER UPDATE ON project_work_verification_execution WHEN NEW.phase='terminal' BEGIN INSERT INTO controlled_child(parent_id) VALUES(1); END`;
        const completed = yield* f.journal.complete(claim, result).pipe(Effect.exit);
        expect(completed._tag).toBe("Failure");
        if (completed._tag === "Failure")
          expect(Cause.pretty(completed.cause)).toContain("FOREIGN KEY constraint failed");
        expect(yield* f.sql`SELECT phase FROM project_work_verification_execution`).toEqual([
          { phase: "terminal" },
        ]);
        const reading = yield* f.journal.readResult(f.selection.jobId).pipe(Effect.exit);
        const recovery = yield* f.journal.readRecoveryPage({ limit: 1 }).pipe(Effect.exit);
        // Test-only cleanup of this disposable connection's failed physical transaction.
        yield* f.sql`ROLLBACK`;
        for (const read of [reading, recovery]) {
          expect(read._tag).toBe("Failure");
          if (read._tag === "Failure")
            expect(Cause.pretty(read.cause)).toContain(
              "cannot start a transaction within a transaction",
            );
        }
        expect(yield* f.journal.readResult(f.selection.jobId)).toBeUndefined();
        yield* f.sql`DROP TRIGGER controlled_commit_failure`;
        expect(yield* f.journal.complete(claim, result)).toEqual(result);
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
      expect((yield* journal.readRecoveryPage({ limit: 1 })).items[0]?.phase).toBe(
        "owner-captured",
      );
      observed = true;
      expect(yield* journal.complete(outcome.claim, result)).toEqual(result);
    }),
  ),
);
