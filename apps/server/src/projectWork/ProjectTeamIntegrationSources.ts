import { reviewDigest } from "./ProjectTeamReviewState.ts";
import {
  ProjectTeamIntegrationSourceRef,
  ProjectTeamIntegrationSources as Sources,
  type ProjectTeamIntegrationSource,
  type ProjectTeamIntegrationSourcePage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";

export class ProjectTeamIntegrationSourcesError extends Schema.TaggedError<ProjectTeamIntegrationSourcesError>()(
  "ProjectTeamIntegrationSourcesError",
  {
    reason: Schema.Literals(["invalid", "stale", "coverage", "unavailable"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
export class ProjectTeamIntegrationSources extends Context.Service<
  ProjectTeamIntegrationSources,
  {
    readonly qualify: (
      state: ProjectWorkReducerState,
      ref: ProjectTeamIntegrationSourceRef,
    ) => Effect.Effect<ProjectTeamIntegrationSource, ProjectTeamIntegrationSourcesError>;
    readonly compile: (
      state: ProjectWorkReducerState,
      input: {
        readonly integrationTaskId: string;
        readonly refs: ReadonlyArray<ProjectTeamIntegrationSourceRef>;
      },
    ) => Effect.Effect<Sources, ProjectTeamIntegrationSourcesError>;
    readonly assertCurrent: (
      state: ProjectWorkReducerState,
      input: { readonly integrationTaskId: string; readonly sources: Sources },
    ) => Effect.Effect<void, ProjectTeamIntegrationSourcesError>;
    readonly coverage: (
      state: ProjectWorkReducerState,
      sources: Sources,
    ) => Effect.Effect<
      { readonly version: 1; readonly selectionSha256: string; readonly combinationSha256: string },
      ProjectTeamIntegrationSourcesError
    >;
    readonly read: (
      state: ProjectWorkReducerState,
      input: {
        readonly integrationTaskId: string;
        readonly ownSourceCursor?: string;
        readonly offset: number;
        readonly limit: number;
      },
    ) => Effect.Effect<ProjectTeamIntegrationSourcePage, ProjectTeamIntegrationSourcesError>;
  }
>()("t3/projectWork/ProjectTeamIntegrationSources") {}
const decodeEffectProjectTeamIntegrationSourceRef = Schema.decodeEffect(
  ProjectTeamIntegrationSourceRef,
);
const OwnCursor = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ]),
);
const decodeOwnCursor = Schema.decodeUnknownEffect(OwnCursor);
const encodeOwnCursor = Schema.encodeEffect(OwnCursor);
const decodeEffectSources = Schema.decodeEffect(Sources);
const isProjectTeamIntegrationSourcesError = Schema.is(ProjectTeamIntegrationSourcesError);
const fail = (reason: ProjectTeamIntegrationSourcesError["reason"]) =>
  new ProjectTeamIntegrationSourcesError({ reason });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isProjectTeamIntegrationSourcesError(cause)
        ? cause
        : new ProjectTeamIntegrationSourcesError({ reason: "unavailable", cause }),
    ),
  );
export const integrationSourceRef = (
  s: ProjectTeamIntegrationSource,
): ProjectTeamIntegrationSourceRef => ({
  taskId: s.taskId,
  bindingId: s.bindingId,
  expectedBindingRevision: s.bindingRevision,
  generation: s.generation,
  reviewDispatchId: s.reviewDispatchId,
  expectedReviewProposalSha256: s.reviewProposalSha256,
  verificationJobId: s.jobId,
  expectedManifestHash: s.manifestHash,
  expectedBranchRef: s.branchRef,
  expectedBaseSha: s.baseSha,
  expectedHeadSha: s.headSha,
  expectedTestedTree: s.testedTree,
});
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reviews = yield* Reviews.ProjectTeamReviewFreshness;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const qualify = Effect.fn("ProjectTeamIntegrationSources.qualify")(function* (
    state: ProjectWorkReducerState,
    ref: ProjectTeamIntegrationSourceRef,
  ) {
    yield* decodeEffectProjectTeamIntegrationSourceRef(ref);
    const { snapshot: s, proof } = yield* reviews.completedDispatch(state, ref.reviewDispatchId);
    const m = s.manifest;
    const source: ProjectTeamIntegrationSource = {
      taskId: m.taskId,
      bindingId: s.source.recordId,
      bindingRevision: s.source.revision,
      generation: s.source.generation,
      dispatchId: m.dispatchId,
      workspaceReceiptSha256: m.workspaceReceiptHash,
      specRevision: m.specRevision,
      planRevision: m.planRevision,
      scopeHash: s.source.scopeHash!,
      branchRef: m.target.branchRef,
      baseSha: m.target.baseSha,
      headSha: m.target.headSha,
      testedTree: m.target.testedTree,
      reviewDispatchId: proof.provenance.dispatchId,
      reviewProposalSha256: proof.proposalSha256,
      joinedReceiptId: proof.joinedReceiptId,
      jobId: m.jobId,
      manifestHash: s.manifestHash,
      attemptId: s.verificationAttemptId,
      resultHash: s.resultHash,
    };
    if (reviewDigest(integrationSourceRef(source)) !== reviewDigest(ref))
      return yield* fail("stale");
    return source;
  }, boundary);
  const owner = (state: ProjectWorkReducerState, taskId: string) => {
    const task = state.tasks.find((t) => t.taskId === taskId);
    const membership = state.foundationRecords?.find(
      (r) => r.kind === "task-membership" && r.taskId === taskId,
    );
    if (
      task === undefined ||
      ["completed", "canceled", "failed"].includes(task.state) ||
      membership?.kind !== "task-membership" ||
      membership.executionKind !== "managed" ||
      membership.deliverableKind !== "code" ||
      membership.status !== "active"
    )
      throw fail("invalid");
    return task;
  };
  const compile = Effect.fn("ProjectTeamIntegrationSources.compile")(function* (
    state: ProjectWorkReducerState,
    input: {
      readonly integrationTaskId: string;
      readonly refs: ReadonlyArray<ProjectTeamIntegrationSourceRef>;
    },
  ) {
    yield* Effect.try({
      try: () => owner(state, input.integrationTaskId),
      catch: () => fail("invalid"),
    });
    if (
      input.refs.some((r) => r.taskId === input.integrationTaskId) ||
      input.refs.length === 0 ||
      input.refs.length > 64 ||
      new Set(input.refs.map((r) => r.taskId)).size !== input.refs.length
    )
      return yield* fail("invalid");
    const sources = yield* Effect.forEach(input.refs, (ref) => qualify(state, ref));
    return yield* decodeEffectSources({ version: 1, environmentId, sources });
  }, boundary);
  const assertCurrent = Effect.fn("ProjectTeamIntegrationSources.assertCurrent")(function* (
    state: ProjectWorkReducerState,
    input: { readonly integrationTaskId: string; readonly sources: Sources },
  ) {
    if (input.sources.environmentId !== environmentId) return yield* fail("stale");
    const current = yield* compile(state, {
      integrationTaskId: input.integrationTaskId,
      refs: input.sources.sources.map(integrationSourceRef),
    });
    if (reviewDigest(current) !== reviewDigest(input.sources)) return yield* fail("stale");
  }, boundary);
  const coverage = Effect.fn("ProjectTeamIntegrationSources.coverage")(function* (
    state: ProjectWorkReducerState,
    sources: Sources,
  ) {
    if (sources.environmentId !== environmentId) return yield* fail("stale");
    const snapshots = yield* Effect.forEach(sources.sources, (source) =>
      Effect.gen(function* () {
        const current = yield* qualify(state, integrationSourceRef(source));
        if (reviewDigest(current) !== reviewDigest(source)) return yield* fail("stale");
        const reviewed = yield* reviews.completedDispatch(state, source.reviewDispatchId);
        return {
          source,
          criteria: reviewed.proof.criteria,
          evidence: reviewed.proof.evidence,
          assessments:
            reviewed.proof.report.type === "project-team.assignment.report"
              ? (reviewed.proof.report.criterionAssessments ?? [])
              : [],
        };
      }),
    );
    if (
      snapshots.some(
        (s) =>
          s.criteria.length === 0 ||
          s.criteria.some(
            (c) =>
              !s.assessments.some(
                (a) =>
                  a.criterionId === c.id &&
                  a.expectedRevision === c.revision &&
                  a.verdict === "met",
              ),
          ),
      )
    )
      return yield* fail("coverage");
    return {
      version: 1 as const,
      selectionSha256: reviewDigest(sources),
      combinationSha256: reviewDigest(snapshots),
    };
  }, boundary);
  const read = Effect.fn("ProjectTeamIntegrationSources.read")(function* (
    state: ProjectWorkReducerState,
    input: {
      readonly integrationTaskId: string;
      readonly ownSourceCursor?: string;
      readonly offset: number;
      readonly limit: number;
    },
  ) {
    const task = yield* Effect.try({
      try: () => owner(state, input.integrationTaskId),
      catch: () => fail("invalid"),
    });
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 64
    )
      return yield* fail("invalid");
    const rows = yield* sql<{
      review_binding_id: string;
    }>`SELECT review_binding_id FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND completion_json IS NOT NULL ORDER BY review_binding_id LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
    const candidates: Array<ProjectTeamIntegrationSourcePage["candidates"][number]> = [];
    for (const row of rows.slice(0, input.limit)) {
      const checked = yield* reviews.completed(state, row.review_binding_id).pipe(Effect.result);
      if (checked._tag === "Failure") continue;
      const { snapshot: s, proof } = checked.success;
      if (s.source.taskId === input.integrationTaskId) continue;
      const m = s.manifest;
      const source: ProjectTeamIntegrationSource = {
        taskId: m.taskId,
        bindingId: s.source.recordId,
        bindingRevision: s.source.revision,
        generation: s.source.generation,
        dispatchId: m.dispatchId,
        workspaceReceiptSha256: m.workspaceReceiptHash,
        specRevision: m.specRevision,
        planRevision: m.planRevision,
        scopeHash: s.source.scopeHash!,
        branchRef: m.target.branchRef,
        baseSha: m.target.baseSha,
        headSha: m.target.headSha,
        testedTree: m.target.testedTree,
        reviewDispatchId: proof.provenance.dispatchId,
        reviewProposalSha256: proof.proposalSha256,
        joinedReceiptId: proof.joinedReceiptId,
        jobId: m.jobId,
        manifestHash: s.manifestHash,
        attemptId: s.verificationAttemptId,
        resultHash: s.resultHash,
      };
      candidates.push({
        ref: integrationSourceRef(source),
        source,
        taskTitle: state.tasks.find((t) => t.taskId === m.taskId)?.title ?? m.taskId,
      });
    }
    const ownCursor =
      input.ownSourceCursor === undefined
        ? undefined
        : yield* decodeOwnCursor(input.ownSourceCursor);
    const ownRows = yield* sql<{
      review_binding_id: string;
      generation: number;
      source_revision: number;
    }>`
      SELECT review_binding_id,json_extract(snapshot_json,'$.source.generation') AS generation,json_extract(snapshot_json,'$.source.revision') AS source_revision
      FROM t3_workflow_v2_team_reviews WHERE environment_id=${environmentId} AND project_id=${state.projectId} AND completion_json IS NOT NULL AND json_extract(snapshot_json,'$.source.taskId')=${task.taskId}
      AND (${ownCursor === undefined ? 1 : 0}=1 OR json_extract(snapshot_json,'$.source.generation')<${ownCursor?.[0] ?? 0} OR (json_extract(snapshot_json,'$.source.generation')=${ownCursor?.[0] ?? 0} AND json_extract(snapshot_json,'$.source.revision')<${ownCursor?.[1] ?? 0}) OR (json_extract(snapshot_json,'$.source.generation')=${ownCursor?.[0] ?? 0} AND json_extract(snapshot_json,'$.source.revision')=${ownCursor?.[1] ?? 0} AND review_binding_id<${ownCursor?.[2] ?? ""}))
      ORDER BY generation DESC,source_revision DESC,review_binding_id DESC LIMIT 65`;
    let ownSource: ProjectTeamIntegrationSourcePage["ownSource"];
    for (const row of ownRows.slice(0, 64)) {
      const reviewed = yield* reviews.completed(state, row.review_binding_id).pipe(Effect.result);
      if (reviewed._tag === "Success") {
        const { snapshot: s, proof } = reviewed.success;
        const m = s.manifest;
        const qualified = yield* qualify(state, {
          taskId: m.taskId,
          bindingId: s.source.recordId,
          expectedBindingRevision: s.source.revision,
          generation: s.source.generation,
          reviewDispatchId: proof.provenance.dispatchId,
          expectedReviewProposalSha256: proof.proposalSha256,
          verificationJobId: m.jobId,
          expectedManifestHash: s.manifestHash,
          expectedBranchRef: m.target.branchRef,
          expectedBaseSha: m.target.baseSha,
          expectedHeadSha: m.target.headSha,
          expectedTestedTree: m.target.testedTree,
        }).pipe(Effect.result);
        if (qualified._tag === "Success" && qualified.success.taskId === task.taskId) {
          ownSource = {
            ref: integrationSourceRef(qualified.success),
            source: qualified.success,
            taskTitle: task.title,
          };
          break;
        }
      }
    }
    return {
      ...(ownSource === undefined && ownRows.length > 64
        ? {
            ownSourceNextCursor: yield* encodeOwnCursor([
              ownRows[63]!.generation,
              ownRows[63]!.source_revision,
              ownRows[63]!.review_binding_id,
            ]),
          }
        : {}),
      ...(ownSource === undefined ? {} : { ownSource }),
      environmentId,
      projectId: task.projectId,
      taskId: task.taskId,
      revision: state.revision,
      taskRevision: task.revision,
      candidates,
      nextOffset: input.offset + Math.min(rows.length, input.limit),
      hasMore: rows.length > input.limit,
    };
  }, boundary);
  return ProjectTeamIntegrationSources.of({ qualify, compile, assertCurrent, coverage, read });
});
export const layer = Layer.effect(ProjectTeamIntegrationSources, make);
