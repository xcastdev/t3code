import * as NodeCrypto from "node:crypto";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime, makeProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { snapshotReviewCriterionAssessments } from "./ProjectTeamReviewCriterionAssessments.ts";
import { at, attribution } from "./ProjectTeamAuthorization.testFixtures.ts";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import {
  verificationFixture,
  makeVerificationAssignmentFixture,
} from "./ProjectWorkVerification.testFixtures.ts";
import { makeProjectTeamReviewCurrentTarget } from "./ProjectTeamReviewCurrentTarget.ts";

const joined = { receiptId: "current-target-joined", stage: "settled" as const, evidence: {} };

it.effect("current review target factory captures dependencies without native IO", () =>
  scoped(
    Effect.gen(function* () {
      const make = vi
        .spyOn(ManagedGit, "make")
        .mockImplementation(() => Effect.die("Unexpected native construction"));
      try {
        yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        expect(make).not.toHaveBeenCalled();
        const injected = { environmentId: "environment", extra: true };
        const invalid = makeProjectTeamReviewCurrentTarget(injected);
        expect(
          (yield* Effect.gen(function* () {
            return yield* invalid;
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      } finally {
        make.mockRestore();
      }
    }),
  ),
);

it.effect("current review target bypasses native loans only for an actually settled dispatch", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const snapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
      const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
      const make = vi
        .spyOn(ManagedGit, "make")
        .mockImplementation(() => Effect.die("Unexpected native construction"));
      try {
        let settlements = 0;
        expect(
          yield* target.withOriginalTarget(
            snapshot,
            joined,
            Effect.sync(() => ++settlements),
          ),
        ).toBe(1);
        expect(make).not.toHaveBeenCalled();
      } finally {
        make.mockRestore();
      }
    }),
  ),
);

it.effect(
  "current review target rejects inherited or foreign transaction ownership before settlement",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const snapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectWorkRepository;
        const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        let settlements = 0;
        const settle = Effect.sync(() => {
          settlements++;
        });
        expect(
          (yield* sql
            .withTransaction(target.withOriginalTarget(snapshot, joined, settle))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* target
            .withOriginalTarget(snapshot, joined, settle)
            .pipe(Effect.provide(SqlitePersistenceMemory), Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* target
            .withOriginalTarget(snapshot, joined, settle)
            .pipe(Effect.provideService(ProjectWorkRepository, { ...repository }), Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(settlements).toBe(0);
      }),
    ),
);

it.effect("current review target assertions require the actual factory-owned live loan", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const snapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
      const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
      const input = { snapshot, jobId: f.prepared.manifest.jobId, manifestHash: f.prepared.sha256 };
      expect((yield* target.assertInTransaction(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* f.sql.withTransaction(target.assertInTransaction(input)).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql
          .withTransaction(target.assertOriginalInTransaction(snapshot, joined))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect(
  "current review target captures settlement inputs synchronously and rejects excess fields",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const originalSnapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
        const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        const snapshot = structuredClone(originalSnapshot);
        const receipt = structuredClone(joined);
        const effect = target.withOriginalTarget(snapshot, receipt, Effect.succeed("original"));
        Reflect.set(snapshot.fence, "dispatchId", "foreign");
        Reflect.set(receipt, "stage", "quarantine");
        expect(yield* effect).toBe("original");
        const injectedSnapshot = { ...originalSnapshot, extra: true };
        const injectedReceipt = { ...joined, extra: true };
        expect(
          (yield* target
            .withOriginalTarget(injectedSnapshot, joined, Effect.void)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* target
            .withOriginalTarget(originalSnapshot, injectedReceipt, Effect.void)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(ProjectTeamWorkspaceReceipt));
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
);

// Retain a schema-valid assessed proposal at the reader boundary. Producer authority and
// full joined reviewer completion require the separate authorized fixture extension.
const assessedTargetFixture = Effect.gen(function* () {
  const f = yield* verificationFixture;
  const review = yield* makeVerificationAssignmentFixture("implementer", "-review");
  const snapshot = yield* review.journal.claimEffect(
    (yield* review.journal.reserve(review.request)).fence,
  );
  const claim = snapshot.intent.compiledClaim.transition;
  if (claim?.kind !== "claim") return yield* Effect.die("Missing controlled review claim");
  const binding = claim.binding;
  const job = f.prepared.manifest;
  const target = {
    projectId: job.projectId,
    taskId: job.taskId,
    specRevision: job.specRevision,
    planRevision: job.planRevision,
    baseSha: job.target.baseSha,
    headSha: job.target.headSha,
  };
  const criterion = f.state.criteria.find((entry) => entry.taskId === job.taskId);
  if (!criterion) return yield* Effect.die("Missing assessed parent criterion");
  const assessments = [
    {
      criterionId: criterion.criterionId,
      expectedRevision: criterion.revision,
      verdict: "not-met" as const,
      detail: "Pending parent review judgment",
      evidenceIds: [],
    },
  ];
  const manifest = {
    version: 1,
    report: {
      type: "project-team.assignment.report",
      projectId: job.projectId,
      taskId: binding.taskId,
      commandId: "current-target-report",
      expectedRevision: 0,
      expectedTaskRevision: 0,
      specRevision: job.specRevision,
      planRevision: job.planRevision,
      assignmentId: "current-target-membership",
      expectedAssignmentRevision: 0,
      summary: "Controlled assessed report",
      evidenceIds: [],
      outputArtifactIds: [],
      outcome: "complete",
      criterionAssessments: assessments,
    },
    attribution,
    operation: {
      environmentId: "environment",
      projectId: job.projectId,
      reviewTaskId: binding.taskId,
      bindingId: binding.recordId,
      generation: binding.generation,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
      operationId: review.request.assignmentOperationId,
      operationKind: "prompt",
      workerId: "review-worker",
      ordinal: 0,
    },
    assignmentRequestHash: hash({}),
    provenance: {
      reviewTaskId: binding.taskId,
      bindingId: binding.recordId,
      generation: binding.generation,
      memberId: binding.memberId,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
      sessionId: "review-session",
      initializeOperationId: review.request.initializeOperationId,
      dispatchId: snapshot.fence.dispatchId,
      targetSha256: hash(target),
    },
    target,
    prepared: {
      jobId: job.jobId,
      sha256: f.prepared.sha256,
      gateId: "controlled-gate",
      gateRevision: 0,
      gateSha256: hash({}),
    },
    freshness: {
      initializeOperationId: review.request.initializeOperationId,
      contentSHA256: hash({}),
      briefingSHA256: hash({}),
      sessionSHA256: hash({}),
    },
    assignment: {
      kind: "task-membership",
      recordId: "current-target-membership",
      projectId: job.projectId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "active",
      taskId: binding.taskId,
      parentTaskId: job.taskId,
      executionKind: "managed",
      deliverableKind: "review",
    },
    criteria: [],
    evidence: [],
    outputs: [],
    reportEvidenceId: "report-evidence",
    reportCommentId: "report-comment",
    findings: [],
    criterionAssessments: yield* snapshotReviewCriterionAssessments({
      assessments,
      state: f.state,
      target,
      prepared: job,
    }),
  };
  yield* f.sql`INSERT INTO project_team_pi_operation
    (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
    VALUES (${review.request.assignmentOperationId},'environment',${job.projectId},${binding.recordId},${binding.generation},${binding.providerInstanceId},${binding.threadId},'review-worker',0,'prompt',${hash({})},${binding.recordId},${binding.taskId},1,1,'settled','{}')`;
  yield* f.sql`INSERT INTO project_team_review_completion_proposal VALUES
    ('environment',${job.projectId},${manifest.report.commandId},${snapshot.fence.dispatchId},${binding.recordId},${binding.generation},${binding.taskId},${job.taskId},${review.request.assignmentOperationId},${manifest.assignmentRequestHash},${canonical(manifest)},${hash(manifest)})`;
  const encoded = encodeWorkspace(f.receipt);
  expect(encoded).not.toBe(canonical(f.receipt));
  expect(hash(yield* decodeWorkspace(encoded))).toBe(job.workspaceReceiptHash);
  // Disposable reader fixture: replace the legacy canonical fixture bytes with production encoding.
  yield* f.sql`DROP TRIGGER project_team_workspace_receipt_immutable`;
  yield* f.sql`UPDATE project_team_workspace_receipt SET receipt_json=${encoded} WHERE dispatch_id=${job.dispatchId}`;
  return { ...f, review, reviewSnapshot: snapshot, manifest, encoded };
});

it.effect(
  "criterion-assessed current target selects the production-encoded receipt and guards settlement",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* assessedTargetFixture;
        const registry = yield* makeProjectTeamPiRuntime();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing implementation claim");
        yield* registry.publishAssets(
          claim.binding.providerInstanceId,
          { runtimeFiles: [], revalidate: Effect.void, borrow: (effect) => effect },
          {
            inspect: Effect.die("Unexpected inspection"),
            prepareOperation: () => Effect.die("Unexpected preparation"),
            readSession: () => Effect.die("Unexpected session read"),
            readThread: () => Effect.die("Unexpected thread read"),
            requestStop: () => Effect.die("Unexpected stop"),
            stopAll: Effect.die("Unexpected stop"),
            authorizeSkills: () => Effect.die("Unexpected skills"),
            discoverNativeSkills: () => Effect.die("Unexpected skills"),
          },
        );
        let permits = 0;
        const service = yield* Effect.gen(function* () {
          return yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ProjectTeamPiRuntime, registry),
              Layer.mock(GitWorkflowService, {
                withRepositoryPermit: (_operation, cwd, effect) => {
                  expect(cwd).toBe(f.receipt.assignment.primaryRoot);
                  permits++;
                  return effect;
                },
              }),
            ),
          ),
        );
        // Both native boundaries are controlled; no filesystem authority or native IO is granted.
        const context = {} as ManagedGit.ManagedGitExecution;
        const make = vi.spyOn(ManagedGit, "make").mockImplementation((options) => {
          expect(options.priorReceipt).toEqual(f.receipt);
          return Effect.succeed(context);
        });
        let reads = 0;
        let drift = false;
        const controlledRead: typeof ManagedGit.withManagedVerificationTarget = (_context, use) => {
          expect(_context).toBe(context);
          reads++;
          return use({
            receipt: f.receipt,
            cwd: f.prepared.manifest.target.worktree,
            ...f.prepared.manifest.target,
            headSha: drift ? "f".repeat(40) : f.prepared.manifest.target.headSha,
          });
        };
        const read = vi
          .spyOn(ManagedGit, "withManagedVerificationTarget")
          .mockImplementation(controlledRead);
        try {
          const assertion = {
            snapshot: f.reviewSnapshot,
            jobId: f.prepared.manifest.jobId,
            manifestHash: f.prepared.sha256,
          };
          let settlements = 0;
          const settle = f.sql.withTransaction(
            Effect.gen(function* () {
              yield* service.assertInTransaction(assertion);
              yield* service.assertOriginalInTransaction(f.reviewSnapshot, joined);
              settlements++;
              return "settled";
            }),
          );
          expect(yield* service.withOriginalTarget(f.reviewSnapshot, joined, settle)).toBe(
            "settled",
          );
          expect(permits).toBe(1);
          expect(make).toHaveBeenCalledTimes(1);
          expect(reads).toBe(2);
          expect(settlements).toBe(1);
          drift = true;
          expect(
            (yield* service
              .withOriginalTarget(f.reviewSnapshot, joined, settle)
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(settlements).toBe(1);
          drift = false;
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
            verifyStage: () => Effect.void,
            verifySettlement: () =>
              service.assertOriginalInTransaction(f.reviewSnapshot, joined).pipe(Effect.orDie),
          });
          const settled = yield* service.withOriginalTarget(
            f.reviewSnapshot,
            joined,
            journal.settleAfterJoined(f.reviewSnapshot.fence, joined),
          );
          expect(settled.fence.stage).toBe("settled");
          expect(
            (yield* f.review.journal.readRetained(f.reviewSnapshot.fence.dispatchId)).fence.stage,
          ).toBe("settled");
          expect(reads).toBeGreaterThan(3);
        } finally {
          read.mockRestore();
          make.mockRestore();
        }
      }),
    ),
);

for (const corruption of ["semantic", "assignment", "invalid", "excess"] as const) {
  it.effect(
    `criterion-assessed current target rejects ${corruption} workspace receipts before settlement`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* assessedTargetFixture;
          const receipt =
            corruption === "semantic"
              ? { ...f.receipt, initialHeadOid: "e".repeat(40) }
              : corruption === "assignment"
                ? {
                    ...f.receipt,
                    assignment: { ...f.receipt.assignment, ownershipToken: "foreign" },
                  }
                : corruption === "invalid"
                  ? { ...f.receipt, initialHeadOid: 123 }
                  : { ...f.receipt, extra: true };
          yield* f.sql`UPDATE project_team_workspace_receipt SET receipt_json=${canonical(receipt)} WHERE dispatch_id=${f.prepared.manifest.dispatchId}`;
          const service = yield* makeProjectTeamReviewCurrentTarget({
            environmentId: "environment",
          });
          let settlements = 0;
          const failure = yield* service
            .withOriginalTarget(
              f.reviewSnapshot,
              joined,
              Effect.sync(() => ++settlements),
            )
            .pipe(Effect.flip);
          expect(failure).toMatchObject(
            corruption === "invalid" || corruption === "excess"
              ? { _tag: "SchemaError" }
              : {
                  _tag: "ProjectTeamReviewCurrentTargetError",
                  reason: "changed",
                  detail: "Original implementation workspace identity changed",
                },
          );
          expect(settlements).toBe(0);
        }),
      ),
  );
}
