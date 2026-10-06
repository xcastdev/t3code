import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectWorkVerificationPreparation,
  ProjectWorkVerificationPreparationError,
  ProjectWorkVerificationPreparationSelection,
} from "./ProjectWorkVerificationPreparation.ts";

const decodeReceipt = Schema.decodeUnknownEffect(ProjectTeamWorkspaceReceipt);
const decodeSelection = Schema.decodeUnknownEffect(ProjectWorkVerificationPreparationSelection);
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const makeFixture = (role: "implementer" | "integrator" = "implementer") =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const result = yield* seed(role, "reserved", {
      roleTools: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      toolIds: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Fixture retains the uncommitted claim"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Fixture did not capture its claim");
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "configure-limits",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records: [
          {
            kind: "limits",
            projectId,
            recordId: "limits",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "configured",
            environmentModelCalls: 4,
            projectWritableWorkers: 1,
            modelCalls: 2,
            delegationDepth: 2,
            repairAllowance: 2,
            model: "test",
            tokenLimit: 2000,
            durationLimitMs: 2000,
          },
        ],
      }),
    );
    yield* TestClock.setTime(Date.parse(at) + 1);
    const claim = {
      ...pending,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          branch: "refs/heads/assigned",
          worktree: "/workspace-assigned",
        },
      },
    };
    const request: ProjectTeamDispatchRequest = {
      dispatchId: "dispatch-intent",
      claim,
      git: {
        effectId: "dispatch-intent",
        runId: "binding",
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: "/workspace-assigned",
        branchRef: "refs/heads/assigned",
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: "setup",
      initializeOperationId: "initialize",
      assignmentOperationId: "assignment",
      assignment: "Implement the approved task",
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    return { sql, repository, request, journal };
  });
const fixture = makeFixture();

const preparedFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
  const settling = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    verifyStage: () => Effect.void,
    verifySettlement: () => Effect.void,
  });
  // Controlled joined receipts exercise real SQL settlement; no native worker ran.
  const snapshot = yield* settling.settleAfterJoined(claimed.fence, {
    receiptId: "prepared-joined",
    stage: "settled",
    evidence: { worker: "joined", setup: "joined", transport: "drained" },
  });
  const receipt = yield* decodeReceipt({
    assignment: f.request.git,
    primary: { path: "/workspace", dev: "1", ino: "1" },
    worktree: { path: "/workspace-assigned", dev: "1", ino: "2" },
    common: { path: "/workspace/.git", dev: "1", ino: "3" },
    gitDirectory: { path: "/workspace/.git/worktrees/assigned", dev: "1", ino: "4" },
    initialHeadOid: "a".repeat(40),
    pointerAndConfigurationHash: "b".repeat(64),
  });
  yield* f.sql`INSERT INTO project_team_workspace_receipt VALUES
    (${f.request.dispatchId},'environment','binding',0,${snapshot.fence.claimGeneration},${canonicalProjectWorkPayload(receipt.assignment)},${canonicalProjectWorkPayload(receipt)})`;
  const state = yield* readCurrentState(f.sql, projectId);
  const binding = state.foundationRecords?.find((r) => r.kind === "run-binding");
  if (binding?.kind !== "run-binding") return yield* Effect.die("Missing settled binding");
  const selectedTask = state.tasks.find((t) => t.taskId === binding.taskId);
  if (!selectedTask) return yield* Effect.die("Missing current task");
  const selection = yield* decodeSelection({
    jobId: "verification-1",
    projectId,
    taskId: selectedTask.taskId,
    expectedRevision: state.revision,
    expectedTaskRevision: selectedTask.revision,
    specRevision: selectedTask.specRevision,
    planRevision: binding.planRevision,
    bindingId: binding.recordId,
    expectedBindingRevision: binding.revision,
    generation: binding.generation,
    criterionIds: state.criteria
      .filter((c) => c.taskId === selectedTask.taskId)
      .map((c) => c.criterionId),
    command: {
      executable: "/bin/bash",
      argv: ["-n", "test.sh"],
      environment: "clean",
      limits: { maxDurationMs: 1000, maxOutputBytes: 4096 },
    },
  });
  let hostCaptures = 0;
  let retained = 0;
  let activeTarget = false;
  let activeExecutable = false;
  let permitted = true;
  let executableHash = "e".repeat(64);
  let beforeUse: Effect.Effect<void> = Effect.void;
  const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: "environment" });
  const preparation = yield* makeProjectWorkVerificationPreparation({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    assertHumanCurrent: () =>
      permitted
        ? Effect.void
        : Effect.fail(
            new ProjectWorkVerificationPreparationError({ reason: "Human access revoked" }),
          ),
    captureWorkspace: (original, use) =>
      Effect.gen(function* () {
        hostCaptures++;
        activeTarget = true;
        yield* beforeUse;
        return yield* use({
          receipt: original.receipt,
          cwd: original.receipt.assignment.worktreePath,
          baseSha: "a".repeat(40),
          headSha: "c".repeat(40),
          testedCommit: "c".repeat(40),
          testedTree: "d".repeat(40),
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            activeTarget = false;
          }),
        ),
      ),
    captureExecutable: (_binding, command, use) =>
      Effect.gen(function* () {
        expect(activeTarget).toBe(true);
        activeExecutable = true;
        return yield* use({
          executableTarget: command.executable,
          sha256: executableHash,
          runtimeClosureSha256: "f".repeat(64),
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            activeExecutable = false;
          }),
        ),
      ),
    retainPrepared: (manifest) =>
      Effect.gen(function* () {
        expect(activeTarget && activeExecutable).toBe(true);
        retained++;
        const receipt = yield* jobs.retainPrepared(manifest);
        expect(receipt.sha256).toBe(
          NodeCrypto.createHash("sha256")
            .update(canonicalProjectWorkPayload(manifest))
            .digest("hex"),
        );
        return receipt;
      }).pipe(
        Effect.mapError(
          () =>
            new ProjectWorkVerificationPreparationError({ reason: "Prepared retention failed" }),
        ),
      ),
  });
  return {
    ...f,
    snapshot,
    receipt,
    selection,
    preparation,
    jobs,
    selectedTask,
    invalidateHostFingerprint: () => {
      executableHash = "invalid";
    },
    revokeHuman: () => {
      permitted = false;
    },
    setBeforeUse: (effect: Effect.Effect<void>) => {
      beforeUse = effect;
    },
    counts: () => ({ hostCaptures, retained, activeTarget, activeExecutable }),
  };
});
const human = { actor: { kind: "human" as const, id: "maintainer" } };

it.effect(
  "prepares the selected settled original implementation without restarting its worker",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* preparedFixture;
        expect(f.selectedTask.approval).toBeUndefined();
        const prepared = yield* f.preparation.prepare(f.selection, human);
        expect(yield* f.jobs.readPrepared(f.selection.jobId)).toEqual(prepared);
        expect(prepared.manifest).toMatchObject({
          jobId: "verification-1",
          environmentId: "environment",
          projectId,
          taskId: f.selection.taskId,
          dispatchId: f.request.dispatchId,
          bindingId: "binding",
          generation: 0,
          command: f.selection.command,
          target: {
            repository: "/workspace",
            worktree: "/workspace-assigned",
            headSha: "c".repeat(40),
            testedCommit: "c".repeat(40),
            testedTree: "d".repeat(40),
            workspaceState: "clean-committed",
          },
          executable: {
            target: "/bin/bash",
            sha256: "e".repeat(64),
            runtimeClosureSha256: "f".repeat(64),
          },
        });
        expect(f.counts()).toEqual({
          hostCaptures: 1,
          retained: 1,
          activeTarget: false,
          activeExecutable: false,
        });
        expect((yield* f.journal.readRetained(f.request.dispatchId)).fence).toEqual(
          f.snapshot.fence,
        );
      }),
    ),
);

for (const change of ["project", "task", "binding", "generation", "criteria"] as const) {
  it.effect("denies stale selected " + change + " before host capture or retention", () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* preparedFixture;
        const selected = structuredClone(f.selection);
        if (change === "project")
          Reflect.set(selected, "expectedRevision", selected.expectedRevision + 1);
        if (change === "task")
          Reflect.set(selected, "expectedTaskRevision", selected.expectedTaskRevision + 1);
        if (change === "binding")
          Reflect.set(selected, "expectedBindingRevision", selected.expectedBindingRevision + 1);
        if (change === "generation") Reflect.set(selected, "generation", selected.generation + 1);
        if (change === "criteria") Reflect.set(selected, "criterionIds", ["foreign-criterion"]);
        expect((yield* f.preparation.prepare(selected, human).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(f.counts()).toEqual({
          hostCaptures: 0,
          retained: 0,
          activeTarget: false,
          activeExecutable: false,
        });
      }),
    ),
  );
}

it.effect("denies agent proposals and missing original workspace receipts before capture", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* preparedFixture;
      expect(
        (yield* f.preparation
          .prepare(f.selection, { actor: { kind: "agent", id: "agent" } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.sql`DELETE FROM project_team_workspace_receipt`;
      expect((yield* f.preparation.prepare(f.selection, human).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(f.counts()).toEqual({
        hostCaptures: 0,
        retained: 0,
        activeTarget: false,
        activeExecutable: false,
      });
    }),
  ),
);

for (const boundary of ["human", "workspace"] as const) {
  it.effect("changed " + boundary + " during capture prevents persistence", () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* preparedFixture;
        f.setBeforeUse(
          boundary === "human"
            ? Effect.sync(() => f.revokeHuman())
            : f.sql`UPDATE project_team_workspace_receipt SET claim_generation=99`.pipe(
                Effect.asVoid,
                Effect.orDie,
              ),
        );
        expect((yield* f.preparation.prepare(f.selection, human).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(f.counts()).toEqual({
          hostCaptures: 1,
          retained: 0,
          activeTarget: false,
          activeExecutable: false,
        });
      }),
    ),
  );
}

it.effect("caller-owned SQL transactions cannot produce a verification preview", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* preparedFixture;
      const pending = f.preparation.prepare(f.selection, human);
      expect((yield* f.sql.withTransaction(pending).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.counts()).toEqual({
        hostCaptures: 0,
        retained: 0,
        activeTarget: false,
        activeExecutable: false,
      });
      expect((yield* pending).manifest.command).toEqual(f.selection.command);
    }),
  ),
);

it.effect("captures selection arguments before later caller mutation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* preparedFixture;
      const caller = structuredClone(f.selection);
      const pending = f.preparation.prepare(caller, human);
      Reflect.set(caller.command, "argv", ["changed"]);
      Reflect.set(caller, "criterionIds", []);
      Reflect.set(caller, "bindingId", "foreign");
      const prepared = yield* pending;
      expect(prepared.manifest.command).toEqual(f.selection.command);
      expect(prepared.manifest.bindingId).toBe(f.selection.bindingId);
      expect(prepared.manifest.criteria.map((c) => c.criterionId)).toEqual(
        f.selection.criterionIds,
      );
    }),
  ),
);

it.effect("physically uncommitted SQL state after a failed commit cannot reach host capture", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* preparedFixture;
      yield* f.sql`PRAGMA foreign_keys=ON`;
      yield* f.sql`CREATE TABLE preparation_parent(id INTEGER PRIMARY KEY)`;
      yield* f.sql`CREATE TABLE preparation_child(parent_id INTEGER REFERENCES preparation_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      expect(
        (yield* f.sql
          .withTransaction(f.sql`INSERT INTO preparation_child VALUES (1)`)
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      const result = yield* f.preparation.prepare(f.selection, human).pipe(Effect.exit);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const loan = yield* f.sql.reserve;
          yield* loan.executeUnprepared("ROLLBACK", [], undefined);
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(f.counts()).toEqual({
        hostCaptures: 0,
        retained: 0,
        activeTarget: false,
        activeExecutable: false,
      });
    }),
  ),
);

it.effect("malformed host capture fails through the typed channel and releases loans", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* preparedFixture;
      f.invalidateHostFingerprint();
      const result = yield* f.preparation.prepare(f.selection, human).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const failures = Cause.findErrorOption(result.cause);
        expect(failures._tag).toBe("Some");
      }
      expect(f.counts()).toEqual({
        hostCaptures: 1,
        retained: 0,
        activeTarget: false,
        activeExecutable: false,
      });
      expect(yield* f.jobs.readPrepared(f.selection.jobId)).toBeUndefined();
    }),
  ),
);
