import { reviewDigest } from "./ProjectTeamReviewState.ts";
import { it, expect } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectWorkTaskId,
  ProjectTeamRunBinding,
  ProjectTeamTaskMembership,
  type ProjectTeamIntegrationSource,
  ProjectTeamReviewCompletionProof,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sources from "./ProjectTeamIntegrationSources.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import { fixture, projectId, environmentId } from "./ProjectTeamReviewFreshness.testkit.ts";

const decodeEffectProjectTeamReviewCompletionProof = Schema.decodeEffect(
  ProjectTeamReviewCompletionProof,
);
const decodeEffectProjectTeamRunBinding = Schema.decodeEffect(ProjectTeamRunBinding);
const decodeEffectProjectTeamTaskMembership = Schema.decodeEffect(ProjectTeamTaskMembership);
it.live("qualifies ordered source references and refuses moved heads or foreign environments", () =>
  Effect.gen(function* () {
    using f = fixture();
    const integrationTaskId = ProjectWorkTaskId.make("integration");
    f.state.tasks.push({ ...f.state.tasks[0]!, taskId: integrationTaskId });
    f.state.foundationRecords!.push(
      yield* decodeEffectProjectTeamTaskMembership({
        ...f.assignment,
        recordId: "integration-assignment",
        taskId: integrationTaskId,
        deliverableKind: "code",
      }),
    );
    const snapshot: Reviews.ReviewSnapshot = {
      version: 1,
      environmentId,
      projectId,
      reviewBindingId: f.reviewer.recordId,
      reviewer: f.reviewer,
      reviewerConfigurationHash: "a".repeat(64),
      reviewScopeHash: "a".repeat(64),
      assignment: f.assignment,
      sourceAssignment: f.sourceAssignment,
      source: f.source,
      manifest: f.manifest,
      manifestHash: f.receipt.manifestHash,
      resultHash: f.receipt.result!.sha256,
      verificationAttemptId: "verification-attempt",
      criteria: f.state.criteria,
      configurationHash: "a".repeat(64),
    };
    // Review freshness is a separate service; this fixture supplies only its completed receipt boundary.
    const proof = yield* decodeEffectProjectTeamReviewCompletionProof({
      status: "completed",
      proposalCommandId: "report",
      proposalSha256: "d".repeat(64),
      assignmentOperationId: "dispatch",
      assignmentRequestHash: "a".repeat(64),
      assignmentReceiptSha256: "b".repeat(64),
      joinedReceiptId: "joined",
      joinedEvidenceSha256: "c".repeat(64),
      report: {
        type: "project-team.assignment.report",
        commandId: "report",
        projectId,
        taskId: f.reviewer.taskId,
        expectedRevision: 0,
        expectedTaskRevision: 0,
        specRevision: 0,
        planRevision: 0,
        assignmentId: f.assignment.recordId,
        expectedAssignmentRevision: 0,
        summary: "Reviewed",
        evidenceIds: [],
        outputArtifactIds: [],
        outcome: "complete",
        criterionAssessments: [
          {
            criterionId: "criterion",
            expectedRevision: 0,
            verdict: "met",
            detail: "Independent check",
            evidenceIds: ["evidence"],
          },
        ],
      },
      reportAttribution: f.attribution,
      assignment: f.assignment,
      target: {
        projectId,
        taskId: f.manifest.taskId,
        specRevision: 0,
        planRevision: 0,
        baseSha: f.manifest.target.baseSha,
        headSha: f.manifest.target.headSha,
      },
      provenance: {
        reviewTaskId: f.reviewer.taskId,
        bindingId: f.reviewer.recordId,
        generation: 1,
        memberId: f.reviewer.memberId,
        providerInstanceId: f.reviewer.providerInstanceId,
        threadId: f.reviewer.threadId,
        sessionId: "session",
        runId: "run",
        runAttemptId: "attempt",
        nodeId: "node",
        initializeOperationId: "dispatch",
        dispatchId: "dispatch",
        targetSha256: "e".repeat(64),
      },
      criteria: [{ id: "criterion", revision: 0, sha256: "f".repeat(64) }],
      evidence: [],
      outputs: [],
      reportEvidenceId: "report-evidence",
      reportCommentId: "report-comment",
      findings: [],
    });
    if (proof.status !== "completed") throw new Error("wrong fixture");
    const source: ProjectTeamIntegrationSource = {
      taskId: f.manifest.taskId,
      bindingId: f.source.recordId,
      bindingRevision: f.source.revision,
      generation: f.source.generation,
      dispatchId: f.manifest.dispatchId,
      workspaceReceiptSha256: f.manifest.workspaceReceiptHash,
      specRevision: f.manifest.specRevision,
      planRevision: f.manifest.planRevision,
      scopeHash: f.source.scopeHash!,
      branchRef: f.manifest.target.branchRef,
      baseSha: f.manifest.target.baseSha,
      headSha: f.manifest.target.headSha,
      testedTree: f.manifest.target.testedTree,
      reviewDispatchId: proof.provenance.dispatchId,
      reviewProposalSha256: proof.proposalSha256,
      joinedReceiptId: proof.joinedReceiptId,
      jobId: f.manifest.jobId,
      manifestHash: snapshot.manifestHash,
      attemptId: snapshot.verificationAttemptId,
      resultHash: snapshot.resultHash,
    };
    const second: ProjectTeamIntegrationSource = {
      ...source,
      taskId: ProjectWorkTaskId.make("second"),
      bindingId: "second-binding",
      reviewDispatchId: "second-review",
      jobId: "second-job",
    };
    let omitAssessment = false;
    const completed = Effect.fn("test.completed")(function* (_state: typeof f.state, id: string) {
      const selected = id === second.reviewDispatchId ? second : source;
      const bound = yield* decodeEffectProjectTeamRunBinding({
        ...snapshot.source,
        recordId: selected.bindingId,
        taskId: selected.taskId,
      });
      const selectedSnapshot = {
        ...snapshot,
        reviewBindingId: selected.reviewDispatchId,
        source: bound,
        manifest: {
          ...snapshot.manifest,
          taskId: selected.taskId,
          bindingId: selected.bindingId,
          jobId: selected.jobId,
        },
      };
      return {
        snapshot: selectedSnapshot,
        proof: {
          ...proof,
          report:
            omitAssessment && proof.report.type === "project-team.assignment.report"
              ? { ...proof.report, criterionAssessments: [] }
              : proof.report,
          provenance: { ...proof.provenance, dispatchId: id },
        },
      };
    }, Effect.orDie);
    const review = Reviews.ProjectTeamReviewFreshness.of({
      freeze: () => Effect.die("unused"),
      read: () => Effect.die("unused"),
      assertPhysical: () => Effect.void,
      assertCurrent: () => Effect.void,
      compile: () => Effect.die("unused"),
      propose: () => Effect.void,
      completeRetained: () => Effect.die("unused"),
      completedDispatch: completed,
      completed: (state, id) =>
        id.startsWith("z-stale")
          ? Effect.fail(new Reviews.ProjectTeamReviewError({ reason: "stale" }))
          : completed(state, id),
    });
    const layer = Sources.layer.pipe(
      Layer.provide(Layer.succeed(Reviews.ProjectTeamReviewFreshness, review)),
      Layer.provideMerge(Persistence.layerMemory),
      Layer.provide(
        Layer.succeed(
          Environment.ServerEnvironment,
          Environment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused"),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Sources.ProjectTeamIntegrationSources;
      const sql = yield* SqlClient.SqlClient;
      const ownTask = f.state.tasks.find((t) => t.taskId === source.taskId)!;
      f.state.foundationRecords!.push(
        yield* decodeEffectProjectTeamTaskMembership({
          ...f.sourceAssignment,
          recordId: "own-source-membership",
          taskId: ownTask.taskId,
          executionKind: "managed",
          deliverableKind: "code",
          status: "active",
        }),
      );
      yield* sql`INSERT INTO t3_workflow_v2_team_reviews(environment_id,project_id,review_binding_id,snapshot_json,snapshot_hash,completion_json) VALUES(${environmentId},${projectId},${source.reviewDispatchId},${JSON.stringify(snapshot)},'hash','{}')`;
      const ownPage = yield* service.read(f.state, {
        integrationTaskId: ownTask.taskId,
        offset: 0,
        limit: 1,
      });
      expect(ownPage.ownSource?.source).toEqual(source);
      expect(ownPage.candidates).toEqual([]);
      const parentPage = yield* service.read(f.state, { integrationTaskId, offset: 0, limit: 1 });
      expect(parentPage.ownSource).toBeUndefined();
      expect(parentPage.candidates[0]?.source).toEqual(source);
      for (let index = 0; index < 65; index++) {
        yield* sql`INSERT INTO t3_workflow_v2_team_reviews(environment_id,project_id,review_binding_id,snapshot_json,snapshot_hash,completion_json) VALUES(${environmentId},${projectId},${`foreign-${index}`},${JSON.stringify({ ...snapshot, source: { ...snapshot.source, taskId: "foreign-task" } })},'hash','{}')`;
      }
      yield* sql`INSERT INTO t3_workflow_v2_team_reviews(environment_id,project_id,review_binding_id,snapshot_json,snapshot_hash,completion_json) VALUES(${environmentId},${projectId},'z-stale-first',${JSON.stringify(snapshot)},'hash','{}')`;
      const fallback = yield* service.read(f.state, {
        integrationTaskId: ownTask.taskId,
        offset: 0,
        limit: 1,
      });
      expect(fallback.ownSource?.source).toEqual(source);
      for (let index = 0; index < 65; index++)
        yield* sql`INSERT INTO t3_workflow_v2_team_reviews(environment_id,project_id,review_binding_id,snapshot_json,snapshot_hash,completion_json) VALUES(${environmentId},${projectId},${`z-stale-${index}`},${JSON.stringify(snapshot)},'hash','{}')`;
      const capped = yield* service.read(f.state, {
        integrationTaskId: ownTask.taskId,
        offset: 0,
        limit: 1,
      });
      expect(capped.ownSource).toBeUndefined();
      expect(capped.ownSourceNextCursor).toBeDefined();
      yield* sql`INSERT INTO t3_workflow_v2_team_reviews(environment_id,project_id,review_binding_id,snapshot_json,snapshot_hash,completion_json) VALUES(${environmentId},${projectId},'z-stale-new-before-cursor',${JSON.stringify(snapshot)},'hash','{}')`;
      const continued = yield* service.read(f.state, {
        integrationTaskId: ownTask.taskId,
        offset: 0,
        limit: 1,
        ownSourceCursor: capped.ownSourceNextCursor!,
      });
      expect(continued.ownSource?.source).toEqual(source);
      expect(continued.ownSourceNextCursor).toBeUndefined();
      const refs = [Sources.integrationSourceRef(second), Sources.integrationSourceRef(source)];
      const selected = yield* service.compile(f.state, { integrationTaskId, refs });
      expect(selected.sources.map((s) => s.taskId)).toEqual(["second", "source-task"]);
      yield* service.assertCurrent(f.state, { integrationTaskId, sources: selected });
      expect(
        (yield* service
          .qualify(f.state, { ...refs[0]!, expectedHeadSha: "f".repeat(40) })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* service
          .assertCurrent(f.state, {
            integrationTaskId,
            sources: { ...selected, environmentId: EnvironmentId.make("foreign") },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const captured = yield* service.coverage(f.state, selected);
      expect(captured.selectionSha256).toBe(reviewDigest(selected));
      const reversed = yield* service.coverage(f.state, {
        ...selected,
        sources: selected.sources.toReversed(),
      });
      expect(reversed.selectionSha256).not.toBe(captured.selectionSha256);
      expect(reversed.combinationSha256).not.toBe(captured.combinationSha256);
      omitAssessment = true;
      expect((yield* service.coverage(f.state, selected).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(layer));
  }),
);
