// @effect-diagnostics-next-line nodeBuiltinImport:off -- Review receipts use the same deterministic SHA-256 identity as Work commands.
import * as NodeCrypto from "node:crypto";
import {
  ProjectTeamTaskMembership,
  ProjectTeamRunBinding,
  ProjectVerificationJobManifest,
  ProjectWorkCriterion,
  ProjectTeamReviewCompletionProof,
  ProjectTeamReviewFinding,
  type ProjectTeamReviewResolutionProof,
  ProjectTeamGuidedIntent,
  ProjectWorkAttribution,
  type ProjectWorkWriteIntent,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import {
  reviewDigest,
  records,
  binding,
  configuration,
  reviewerConfiguration,
  reviewTaskScope,
  assertReviewSnapshotState,
} from "./ProjectTeamReviewState.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import { assertVerificationTarget } from "./ProjectWorkVerificationExecution.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export class ProjectTeamReviewError extends Schema.TaggedError<ProjectTeamReviewError>()(
  "ProjectTeamReviewError",
  {
    reason: Schema.Literals([
      "stale",
      "missing",
      "invalid",
      "storage",
      "independence",
      "incomplete",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
export const ReviewSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  projectId: Schema.String,
  reviewBindingId: Schema.String,
  reviewer: ProjectTeamRunBinding,
  reviewerConfigurationHash: Digest,
  reviewScopeHash: Digest,
  assignment: ProjectTeamTaskMembership,
  sourceAssignment: ProjectTeamTaskMembership,
  source: ProjectTeamRunBinding,
  manifest: ProjectVerificationJobManifest,
  manifestHash: Digest,
  resultHash: Digest,
  verificationAttemptId: Schema.String,
  criteria: Schema.Array(ProjectWorkCriterion),
  configurationHash: Digest,
});
export type ReviewSnapshot = typeof ReviewSnapshot.Type;
type Report = Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }>;
type Foundation = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
export interface ReviewJoin {
  readonly assignmentOperationId: string;
  readonly assignmentRequestHash: string;
  readonly assignmentReceiptSha256: string;
  readonly joinedReceiptId: string;
  readonly joinedEvidenceSha256: string;
}
export class ProjectTeamReviewFreshness extends Context.Service<
  ProjectTeamReviewFreshness,
  {
    readonly assertPhysical: (
      projectId: string,
      jobId: string,
    ) => Effect.Effect<void, ProjectTeamReviewError>;
    readonly freeze: (
      state: ProjectWorkReducerState,
      input: { readonly reviewBindingId: string; readonly jobId: string },
    ) => Effect.Effect<ReviewSnapshot, ProjectTeamReviewError>;
    readonly assertCurrent: (
      state: ProjectWorkReducerState,
      snapshot: ReviewSnapshot,
    ) => Effect.Effect<void, ProjectTeamReviewError>;
    readonly compile: (
      state: ProjectWorkReducerState,
      intent: ProjectWorkWriteIntent,
      attribution: ProjectWorkAttribution,
    ) => Effect.Effect<Foundation, ProjectTeamReviewError>;
    readonly propose: (
      state: ProjectWorkReducerState,
      report: Report,
      attribution: ProjectWorkAttribution,
    ) => Effect.Effect<void, ProjectTeamReviewError>;
    readonly completeRetained: (
      state: ProjectWorkReducerState,
      reviewBindingId: string,
      join: ReviewJoin,
    ) => Effect.Effect<ProjectTeamReviewCompletionProof, ProjectTeamReviewError>;
    readonly completedDispatch: (
      state: ProjectWorkReducerState,
      dispatchId: string,
    ) => Effect.Effect<
      {
        readonly snapshot: ReviewSnapshot;
        readonly proof: Extract<ProjectTeamReviewCompletionProof, { status: "completed" }>;
      },
      ProjectTeamReviewError
    >;
    readonly completed: (
      state: ProjectWorkReducerState,
      reviewBindingId: string,
    ) => Effect.Effect<
      {
        readonly snapshot: ReviewSnapshot;
        readonly proof: Extract<ProjectTeamReviewCompletionProof, { status: "completed" }>;
      },
      ProjectTeamReviewError
    >;
    readonly read: (
      projectId: string,
      reviewBindingId: string,
    ) => Effect.Effect<ReviewSnapshot, ProjectTeamReviewError>;
  }
>()("t3/projectWork/ProjectTeamReviewFreshness") {}
const snapshotJson = Schema.fromJsonString(ReviewSnapshot);
const proposalJson = Schema.fromJsonString(
  Schema.Struct({ report: ProjectTeamGuidedIntent, attribution: ProjectWorkAttribution }),
);
const proofJson = Schema.fromJsonString(ProjectTeamReviewCompletionProof);
const decodeSnapshot = Schema.decodeUnknownEffect(snapshotJson);
const decodeProof = Schema.decodeUnknownEffect(proofJson);
const encodeSnapshot = Schema.encodeEffect(snapshotJson);
const encodeProof = Schema.encodeEffect(proofJson);
const decodeEffectProjectTeamReviewCompletionProof = Schema.decodeEffect(
  ProjectTeamReviewCompletionProof,
);
const isProjectTeamReviewError = Schema.is(ProjectTeamReviewError);
const fail = (reason: ProjectTeamReviewError["reason"]) => new ProjectTeamReviewError({ reason });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isProjectTeamReviewError(cause)
        ? cause
        : new ProjectTeamReviewError({ reason: "storage", cause }),
    ),
  );
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const verification = yield* Verification.ProjectWorkVerification;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environmentId = yield* environment.getEnvironmentId;
  const transaction = Effect.gen(function* () {
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* fail("invalid");
  });
  const read = Effect.fn("ProjectTeamReviewFreshness.read")(function* (
    projectId: string,
    reviewBindingId: string,
  ) {
    const rows = yield* sql<{
      snapshot_json: string;
      snapshot_hash: string;
    }>`SELECT snapshot_json,snapshot_hash FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${projectId} AND review_binding_id=${reviewBindingId}`;
    const row = rows[0];
    if (row === undefined) return yield* fail("missing");
    const snapshot = yield* decodeSnapshot(row.snapshot_json);
    if (
      reviewDigest(snapshot) !== row.snapshot_hash ||
      snapshot.environmentId !== environmentId ||
      snapshot.projectId !== projectId ||
      snapshot.reviewBindingId !== reviewBindingId
    )
      return yield* fail("invalid");
    return snapshot;
  }, boundary);
  const assertCurrent = Effect.fn("ProjectTeamReviewFreshness.assertCurrent")(function* (
    state: ProjectWorkReducerState,
    s: ReviewSnapshot,
  ) {
    if (s.environmentId !== environmentId) return yield* fail("stale");
    yield* Effect.try({
      try: () => assertReviewSnapshotState(state, s),
      catch: () => fail("stale"),
    });
    const retained = yield* verification.read(s.projectId, s.manifest.jobId);
    if (
      Option.isNone(retained) ||
      retained.value.stage !== "applied" ||
      retained.value.manifestHash !== s.manifestHash ||
      reviewDigest(retained.value.manifest) !== reviewDigest(s.manifest) ||
      retained.value.result?.sha256 !== s.resultHash ||
      retained.value.claimId !== s.verificationAttemptId ||
      retained.value.result.outcome !== "success" ||
      retained.value.result.exitCode !== 0
    )
      return yield* fail("stale");
  }, boundary);
  const assertPhysical = Effect.fn("ProjectTeamReviewFreshness.assertPhysical")(function* (
    projectId: string,
    jobId: string,
  ) {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* fail("invalid");
    const receipt = yield* verification.read(projectId, jobId);
    if (
      Option.isNone(receipt) ||
      receipt.value.stage !== "applied" ||
      receipt.value.result?.outcome !== "success" ||
      receipt.value.result.exitCode !== 0
    )
      return yield* fail("stale");
    yield* assertVerificationTarget(receipt.value.manifest.target).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
  }, boundary);
  const freeze = Effect.fn("ProjectTeamReviewFreshness.freeze")(function* (
    state: ProjectWorkReducerState,
    input: { readonly reviewBindingId: string; readonly jobId: string },
  ) {
    yield* transaction;
    const reviewer = binding(state, input.reviewBindingId);
    const assignment = records(state).find(
      (r): r is typeof ProjectTeamTaskMembership.Type =>
        r.kind === "task-membership" && r.taskId === reviewer?.taskId,
    );
    const retained = yield* verification.read(state.projectId, input.jobId);
    if (
      reviewer === undefined ||
      reviewer.status !== "reserved" ||
      reviewer.environmentId !== environmentId ||
      reviewer.generation !== reviewer.leaseGeneration ||
      reviewer.runId !== undefined ||
      assignment?.executionKind !== "managed" ||
      assignment.deliverableKind !== "review" ||
      assignment.parentTaskId === undefined ||
      Option.isNone(retained)
    )
      return yield* fail("invalid");
    const { manifest, manifestHash, result, stage, claimId } = retained.value;
    const source = binding(state, manifest.bindingId);
    const sourceAssignment = records(state).find(
      (r) => r.kind === "task-membership" && r.taskId === source?.taskId,
    );
    if (
      stage !== "applied" ||
      claimId === undefined ||
      result?.outcome !== "success" ||
      result.exitCode !== 0 ||
      source === undefined ||
      source.status !== "settled" ||
      sourceAssignment?.kind !== "task-membership" ||
      sourceAssignment.executionKind !== "managed" ||
      sourceAssignment.deliverableKind !== "code" ||
      sourceAssignment.status !== "active" ||
      source.taskId !== assignment.parentTaskId ||
      manifest.taskId !== source.taskId ||
      manifest.environmentId !== environmentId ||
      source.specRevision !== manifest.specRevision ||
      source.planRevision !== manifest.planRevision ||
      source.worktree !== manifest.target.worktree ||
      (source.branch !== null &&
        (source.branch.startsWith("refs/heads/")
          ? source.branch
          : `refs/heads/${source.branch}`) !== manifest.target.branchRef) ||
      source.workspaceState === "pending" ||
      source.generation !== source.leaseGeneration ||
      source.generation !== manifest.generation ||
      source.runId !== manifest.runId ||
      source.runAttemptId !== manifest.runAttemptId ||
      source.nodeId !== manifest.nodeId ||
      source.environmentId !== environmentId ||
      source.scopeHash === undefined
    )
      return yield* fail("invalid");
    if (
      source.memberId === reviewer.memberId ||
      source.threadId === reviewer.threadId ||
      source.recordId === reviewer.recordId
    )
      return yield* fail("independence");
    const snapshot: ReviewSnapshot = {
      version: 1,
      environmentId,
      projectId: state.projectId,
      reviewBindingId: reviewer.recordId,
      reviewer,
      reviewerConfigurationHash: reviewerConfiguration(reviewer),
      reviewScopeHash: reviewTaskScope(state, reviewer.taskId),
      assignment,
      sourceAssignment,
      source,
      manifest,
      manifestHash,
      resultHash: result.sha256,
      verificationAttemptId: claimId,
      criteria: state.criteria
        .filter((c) => c.taskId === source.taskId)
        .toSorted((a, b) => a.criterionId.localeCompare(b.criterionId)),
      configurationHash: configuration(state),
    };
    if (
      snapshot.criteria.length === 0 ||
      manifest.criteria.length !== snapshot.criteria.length ||
      snapshot.criteria.some(
        (c) =>
          !manifest.criteria.some(
            (m) => m.criterionId === c.criterionId && m.revision === c.revision,
          ),
      )
    )
      return yield* fail("stale");
    yield* assertCurrent(state, snapshot);
    const existing = yield* sql<{
      snapshot_hash: string;
    }>`SELECT snapshot_hash FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${reviewer.recordId}`;
    if (existing[0] !== undefined) {
      if (existing[0].snapshot_hash !== reviewDigest(snapshot)) return yield* fail("stale");
      return snapshot;
    }
    yield* sql`INSERT INTO t3_workflow_v2_team_reviews(environment_id,project_id,review_binding_id,snapshot_json,snapshot_hash) VALUES(${environmentId},${state.projectId},${reviewer.recordId},${yield* encodeSnapshot(snapshot)},${reviewDigest(snapshot)})`;
    return snapshot;
  }, boundary);
  const reviewerFor = Effect.fn("ProjectTeamReviewFreshness.reviewerFor")(function* (
    state: ProjectWorkReducerState,
    attribution: ProjectWorkAttribution,
    taskId?: string,
    terminal = false,
  ) {
    const candidates = records(state).filter(
      (r): r is typeof ProjectTeamRunBinding.Type =>
        r.kind === "run-binding" &&
        (r.status === "running" || (terminal && ["stopping", "settled"].includes(r.status))) &&
        (taskId === undefined || r.taskId === taskId) &&
        r.threadId === attribution.actor.id &&
        r.sessionId === attribution.source.id,
    );
    if (
      attribution.actor.kind !== "agent" ||
      attribution.source.kind !== "mcp" ||
      candidates.length !== 1
    )
      return yield* fail("invalid");
    const b = candidates[0]!;
    if (
      b.runId === undefined ||
      b.runAttemptId === undefined ||
      b.nodeId === undefined ||
      b.sessionId === undefined
    )
      return yield* fail("incomplete");
    const dispatch = yield* sql<{
      dispatch_id: string;
    }>`SELECT dispatch_id FROM t3_workflow_v2_team_dispatches WHERE project_id=${state.projectId} AND binding_id=${b.recordId} AND generation=${b.generation}`;
    if (dispatch.length !== 1) return yield* fail("incomplete");
    const snapshot = yield* read(state.projectId, b.recordId);
    if (
      snapshot.source.sessionId === b.sessionId ||
      snapshot.source.runId === b.runId ||
      snapshot.source.runAttemptId === b.runAttemptId
    )
      return yield* fail("independence");
    yield* assertCurrent(state, snapshot);
    return {
      b,
      snapshot,
      provenance: {
        reviewTaskId: b.taskId,
        bindingId: b.recordId,
        generation: b.generation,
        memberId: b.memberId,
        providerInstanceId: b.providerInstanceId,
        threadId: b.threadId,
        sessionId: b.sessionId,
        runId: b.runId,
        runAttemptId: b.runAttemptId,
        nodeId: b.nodeId,
        initializeOperationId: dispatch[0]!.dispatch_id,
        dispatchId: dispatch[0]!.dispatch_id,
        targetSha256: reviewDigest(snapshot.manifest.target),
      },
    };
  });
  const compile = Effect.fn("ProjectTeamReviewFreshness.compile")(function* (
    state: ProjectWorkReducerState,
    intent: ProjectWorkWriteIntent,
    attribution: ProjectWorkAttribution,
  ) {
    if (
      intent.type !== "project-team.review.finding.record" ||
      intent.projectId !== state.projectId ||
      intent.expectedRevision !== state.revision ||
      state.tasks.find((t) => t.taskId === intent.taskId)?.revision !== intent.expectedTaskRevision
    )
      return yield* fail("invalid");
    const { b, snapshot, provenance } = yield* reviewerFor(state, attribution);
    if (
      intent.specRevision !== b.specRevision ||
      intent.planRevision !== b.planRevision ||
      intent.taskId !== b.taskId
    )
      return yield* fail("stale");
    const prior = records(state).find(
      (r): r is ProjectTeamReviewFinding =>
        r.kind === "review-finding" && r.findingId === intent.findingId,
    );
    if (intent.status === "resolved") {
      if (
        prior === undefined ||
        (prior.status !== "open" && prior.reportedBy.targetSha256 === provenance.targetSha256) ||
        prior.revision + 1 !== intent.revision ||
        prior.taskId !== snapshot.source.taskId ||
        prior.originReviewer.bindingId === b.recordId ||
        intent.criterionIds.some((id) => !prior.criterionIds.includes(id)) ||
        reviewDigest(intent.criterionIds) !== reviewDigest(prior.criterionIds)
      )
        return yield* fail("invalid");
      const retained = yield* verification.read(state.projectId, snapshot.manifest.jobId);
      if (Option.isNone(retained) || retained.value.result === undefined)
        return yield* fail("invalid");
      const result = retained.value.result;
      const artifacts = [
        { artifactId: `${snapshot.manifest.jobId}:stdout`, bytes: result.stdout },
        { artifactId: `${snapshot.manifest.jobId}:stderr`, bytes: result.stderr },
      ].filter((a) => intent.resolutionArtifactIds.includes(a.artifactId));
      if (
        artifacts.length !== intent.resolutionArtifactIds.length ||
        artifacts.length === 0 ||
        artifacts.some((a) => a.bytes.trim().length === 0)
      )
        return yield* fail("invalid");
      const finding: ProjectTeamReviewFinding = {
        ...prior,
        severity: intent.severity,
        detail: intent.detail,
        status: "resolved",
        revision: intent.revision,
        updatedAt: attribution.recordedAt,
        generation: b.generation,
        resolutionArtifactIds: intent.resolutionArtifactIds,
        reportedBy: provenance,
      };
      const proof: ProjectTeamReviewResolutionProof = {
        version: 1,
        environmentId,
        prior: { revision: prior.revision, sha256: reviewDigest(prior) },
        target: {
          projectId: snapshot.manifest.projectId,
          taskId: snapshot.manifest.taskId,
          specRevision: snapshot.manifest.specRevision,
          planRevision: snapshot.manifest.planRevision,
          baseSha: snapshot.manifest.target.baseSha,
          headSha: snapshot.manifest.target.headSha,
        },
        reviewTargetSha256: provenance.targetSha256,
        jobId: snapshot.manifest.jobId,
        manifestHash: snapshot.manifestHash,
        attemptId: snapshot.verificationAttemptId,
        resultHash: snapshot.resultHash,
        artifacts: artifacts.map((a) => ({
          artifactId: a.artifactId,
          sha256: NodeCrypto.createHash("sha256").update(a.bytes).digest("hex"),
          byteCount: Buffer.byteLength(a.bytes),
        })),
      };
      return {
        type: "project-work.foundation.commit",
        commandId: intent.commandId,
        projectId: intent.projectId,
        expectedRevision: intent.expectedRevision,
        records: [],
        attribution,
        committedAt: attribution.recordedAt,
        transition: { kind: "review.resolve", finding, proof },
      } satisfies Foundation;
    }
    if (
      intent.resolutionArtifactIds.length !== 0 ||
      intent.criterionIds.some((id) => !snapshot.criteria.some((c) => c.criterionId === id)) ||
      intent.revision !== (prior === undefined ? 0 : prior.revision + 1) ||
      (prior !== undefined &&
        (prior.status !== "open" || prior.originReviewer.bindingId !== b.recordId))
    )
      return yield* fail("invalid");
    const finding: ProjectTeamReviewFinding = {
      kind: "review-finding",
      recordId:
        prior?.recordId ??
        projectTeamDerivedRecordId(state.projectId, `review-finding:${intent.findingId}`),
      projectId: intent.projectId,
      revision: intent.revision,
      generation: b.generation,
      updatedAt: attribution.recordedAt,
      findingId: intent.findingId,
      severity: intent.severity,
      criterionIds: intent.criterionIds,
      detail: intent.detail,
      status: "open",
      resolutionArtifactIds: [],
      taskId: snapshot.source.taskId,
      target: {
        projectId: snapshot.manifest.projectId,
        taskId: snapshot.manifest.taskId,
        specRevision: snapshot.manifest.specRevision,
        planRevision: snapshot.manifest.planRevision,
        baseSha: snapshot.manifest.target.baseSha,
        headSha: snapshot.manifest.target.headSha,
      },
      originReviewer: prior?.originReviewer ?? provenance,
      reportedBy: provenance,
    };
    return {
      type: "project-work.foundation.commit",
      commandId: intent.commandId,
      projectId: intent.projectId,
      expectedRevision: intent.expectedRevision,
      records: [finding],
      attribution,
      committedAt: attribution.recordedAt,
    } satisfies Foundation;
  }, boundary);
  const complete = Effect.fn("ProjectTeamReviewFreshness.complete")(function* (
    state: ProjectWorkReducerState,
    report: Report,
    attribution: ProjectWorkAttribution,
    join: ReviewJoin,
  ) {
    yield* transaction;
    const { b, snapshot, provenance } = yield* reviewerFor(state, attribution, report.taskId, true);
    if (
      report.outcome !== "complete" ||
      report.assignmentId !== snapshot.assignment.recordId ||
      report.expectedAssignmentRevision !== snapshot.assignment.revision ||
      report.projectId !== state.projectId ||
      report.specRevision !== b.specRevision ||
      report.planRevision !== b.planRevision ||
      report.outputs?.length ||
      report.outputArtifactIds.length
    )
      return yield* fail("invalid");
    const assessments = report.criterionAssessments ?? [];
    if (
      assessments.length !== snapshot.criteria.length ||
      assessments.some(
        (a) =>
          a.verdict !== "met" ||
          !snapshot.criteria.some(
            (c) => c.criterionId === a.criterionId && c.revision === a.expectedRevision,
          ) ||
          a.evidenceIds.length === 0 ||
          a.evidenceIds.some(
            (id) =>
              !state.evidence.some(
                (e) =>
                  e.evidenceId === id &&
                  e.taskId === snapshot.source.taskId &&
                  e.scopeHash === snapshot.source.scopeHash,
              ),
          ),
      )
    )
      return yield* fail("incomplete");
    const findings = records(state).filter(
      (r): r is ProjectTeamReviewFinding =>
        r.kind === "review-finding" && r.taskId === snapshot.source.taskId,
    );
    // A repaired target needs a new independent review; a resolution label never clears its original finding.
    if (
      findings.some(
        (f) => f.status === "open" || f.reportedBy.targetSha256 !== provenance.targetSha256,
      )
    )
      return yield* fail("incomplete");
    const evidence = state.evidence.filter((e) =>
      assessments.some((a) => a.evidenceIds.includes(e.evidenceId)),
    );
    const proof = yield* decodeEffectProjectTeamReviewCompletionProof({
      status: "completed",
      proposalCommandId: report.commandId,
      proposalSha256: reviewDigest(report),
      ...join,
      report,
      reportAttribution: attribution,
      assignment: snapshot.assignment,
      target: {
        projectId: snapshot.manifest.projectId,
        taskId: snapshot.manifest.taskId,
        specRevision: snapshot.manifest.specRevision,
        planRevision: snapshot.manifest.planRevision,
        baseSha: snapshot.manifest.target.baseSha,
        headSha: snapshot.manifest.target.headSha,
      },
      provenance,
      criteria: snapshot.criteria.map((c) => ({
        id: c.criterionId,
        revision: c.revision,
        sha256: reviewDigest(c),
      })),
      evidence: evidence.map((e) => ({
        id: e.evidenceId,
        revision: e.revision,
        sha256: reviewDigest(e),
      })),
      outputs: [],
      reportEvidenceId: projectTeamDerivedRecordId(report.commandId, "review-report-evidence"),
      reportCommentId: projectTeamDerivedRecordId(report.commandId, "review-report-comment"),
      findings: findings.map((f) => ({
        findingId: f.findingId,
        revision: f.revision,
        sha256: reviewDigest(f),
      })),
    });
    const encoded = yield* encodeProof(proof);
    const prior = yield* sql<{
      completion_json: string | null;
    }>`SELECT completion_json FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${b.recordId}`;
    if (prior[0]?.completion_json !== null && prior[0]?.completion_json !== encoded)
      return yield* fail("stale");
    yield* sql`UPDATE t3_workflow_v2_team_reviews SET completion_json=${encoded} WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${b.recordId} AND completion_json IS NULL`;
    return proof;
  }, boundary);
  const propose = Effect.fn("ProjectTeamReviewFreshness.propose")(function* (
    state: ProjectWorkReducerState,
    report: Report,
    attribution: ProjectWorkAttribution,
  ) {
    yield* transaction;
    const { b, snapshot } = yield* reviewerFor(state, attribution, report.taskId);
    if (
      report.outcome !== "complete" ||
      report.assignmentId !== snapshot.assignment.recordId ||
      report.expectedAssignmentRevision !== snapshot.assignment.revision ||
      report.expectedRevision !== state.revision ||
      report.projectId !== state.projectId ||
      report.specRevision !== b.specRevision ||
      report.planRevision !== b.planRevision
    )
      return yield* fail("invalid");
    const encoded = yield* Schema.encodeEffect(proposalJson)({ report, attribution });
    const row = (yield* sql<{
      proposal_json: string | null;
    }>`SELECT proposal_json FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${b.recordId}`)[0];
    if (row === undefined || (row.proposal_json !== null && row.proposal_json !== encoded))
      return yield* fail("stale");
    yield* sql`UPDATE t3_workflow_v2_team_reviews SET proposal_json=${encoded} WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${b.recordId} AND proposal_json IS NULL`;
  }, boundary);
  const completeRetained = Effect.fn("ProjectTeamReviewFreshness.completeRetained")(function* (
    state: ProjectWorkReducerState,
    reviewBindingId: string,
    join: ReviewJoin,
  ) {
    yield* transaction;
    const row = (yield* sql<{
      proposal_json: string | null;
    }>`SELECT proposal_json FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${reviewBindingId}`)[0];
    if (row?.proposal_json == null) return yield* fail("missing");
    const proposal = yield* Schema.decodeEffect(proposalJson)(row.proposal_json);
    if (proposal.report.type !== "project-team.assignment.report") return yield* fail("invalid");
    const proof = yield* complete(state, proposal.report, proposal.attribution, join);
    return proof;
  }, boundary);
  const completed = Effect.fn("ProjectTeamReviewFreshness.completed")(function* (
    state: ProjectWorkReducerState,
    reviewBindingId: string,
  ) {
    const snapshot = yield* read(state.projectId, reviewBindingId);
    yield* assertCurrent(state, snapshot);
    const b = binding(state, reviewBindingId);
    if (
      b?.status !== "settled" ||
      state.tasks.find((t) => t.taskId === b.taskId)?.state !== "completed"
    )
      return yield* fail("incomplete");
    const row = (yield* sql<{
      completion_json: string | null;
    }>`SELECT completion_json FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND review_binding_id=${reviewBindingId}`)[0];
    if (row?.completion_json == null) return yield* fail("incomplete");
    const proof = yield* decodeProof(row.completion_json);
    if (
      proof.status !== "completed" ||
      proof.provenance.bindingId !== reviewBindingId ||
      proof.provenance.generation !== b.generation ||
      proof.provenance.runId !== b.runId ||
      proof.provenance.runAttemptId !== b.runAttemptId ||
      proof.provenance.nodeId !== b.nodeId ||
      records(state).some(
        (r) =>
          r.kind === "review-finding" && r.taskId === snapshot.source.taskId && r.status === "open",
      )
    )
      return yield* fail("stale");
    if (
      reviewDigest(proof.report) !== proof.proposalSha256 ||
      proof.evidence.some((e) => {
        const current = state.evidence.find((c) => c.evidenceId === e.id);
        return (
          current === undefined ||
          current.revision !== e.revision ||
          reviewDigest(current) !== e.sha256
        );
      })
    )
      return yield* fail("stale");
    const findings = records(state).filter(
      (r): r is ProjectTeamReviewFinding =>
        r.kind === "review-finding" && r.taskId === snapshot.source.taskId,
    );
    if (
      findings.length !== proof.findings.length ||
      findings.some(
        (f) =>
          !proof.findings.some(
            (p) =>
              p.findingId === f.findingId &&
              p.revision === f.revision &&
              p.sha256 === reviewDigest(f),
          ),
      )
    )
      return yield* fail("stale");
    return { snapshot, proof };
  }, boundary);
  const completedDispatch = Effect.fn("ProjectTeamReviewFreshness.completedDispatch")(function* (
    state: ProjectWorkReducerState,
    dispatchId: string,
  ) {
    const rows = yield* sql<{
      binding_id: string;
    }>`SELECT binding_id FROM t3_workflow_v2_team_dispatches WHERE project_id=${state.projectId} AND dispatch_id=${dispatchId}`;
    if (rows.length !== 1) return yield* fail("missing");
    const result = yield* completed(state, rows[0]!.binding_id);
    if (result.proof.provenance.dispatchId !== dispatchId) return yield* fail("stale");
    return result;
  }, boundary);
  return ProjectTeamReviewFreshness.of({
    assertPhysical,
    freeze,
    assertCurrent,
    compile,
    propose,
    completeRetained,
    completed,
    completedDispatch,
    read,
  });
});
export const layer = Layer.effect(ProjectTeamReviewFreshness, make);
