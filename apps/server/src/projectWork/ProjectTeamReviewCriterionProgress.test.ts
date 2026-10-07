import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  canonicalProjectWorkPayload,
  EventId,
  ProjectId,
  ProjectTeamRecord,
  ProjectTeamReviewCompletionProof,
  ProjectTeamReviewResolutionProof,
  ProjectWorkCriterion,
  ProjectWorkEvidence,
  ProjectWorkTask,
} from "@t3tools/contracts";
import {
  applyProjectWorkEvents,
  emptyProjectWorkReducerState,
  type ProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import {
  prepareReviewCriterionProgress,
  invalidateReviewCriterionProgress,
  assertRetainedReviewCriterionProgress,
} from "./ProjectTeamReviewCriterionProgress.ts";
import { prepareReviewFindingResolutionEvidence } from "./ProjectTeamReviewResolutionRecords.ts";

const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const criterion = Schema.decodeUnknownSync(ProjectWorkCriterion, strict);
const evidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const record = Schema.decodeUnknownSync(ProjectTeamRecord, strict);
const task = Schema.decodeUnknownSync(ProjectWorkTask, strict);
const proof = Schema.decodeUnknownSync(ProjectTeamReviewCompletionProof, strict);
const decodeResolutionProof = Schema.decodeUnknownSync(ProjectTeamReviewResolutionProof, strict);
const at = "2026-01-01T00:00:00.000Z";
const human = {
  actor: { kind: "human", id: "human" },
  source: { kind: "web", id: "browser" },
  recordedAt: at,
} as const;
const target = {
  projectId: ProjectId.make("project"),
  taskId: ProjectWorkTask.fields.taskId.make("parent"),
  specRevision: 2,
  planRevision: 3,
  baseSha: "b".repeat(40),
  headSha: "c".repeat(40),
};
const reviewer = {
  reviewTaskId: "review-child",
  bindingId: "review-binding",
  generation: 1,
  memberId: "reviewer",
  providerInstanceId: "pi",
  threadId: "review-thread",
  sessionId: "session",
  initializeOperationId: "initialize",
  dispatchId: "review-dispatch",
  targetSha256: "e".repeat(64),
};
const verification = {
  environmentId: "environment",
  jobId: "job",
  manifestHash: "a".repeat(64),
  attemptId: "verification-attempt",
  resultHash: "d".repeat(64),
  outcome: "success",
  exitCode: 0,
  evidenceId: "verification-evidence",
  applicabilityId: "verification-applicability",
};
const settlement = {
  commandId: "joined-command",
  commandFingerprint: "0123abcd",
  dispatchId: reviewer.dispatchId,
  joinedReceiptId: "joined-receipt",
};

/** Pure trusted-proof controls only. Actual qualification, SQL and retained bytes are covered by Findings tests. */
function fixture(
  options: {
    readonly status?: "unsatisfied" | "satisfied" | "waived";
    readonly ids?: readonly string[];
  } = {},
) {
  const parent = task({
    taskId: target.taskId,
    projectId: target.projectId,
    title: "Parent",
    state: "in-progress",
    watchers: [],
    revision: 4,
    specRevision: 2,
    createdAt: at,
    updatedAt: at,
    specification: {
      objective: "Deliver",
      scopeIn: "Exact scope",
      scopeOut: "Other scope",
      criterionIds: ["selected", "other"],
      revision: 2,
      protected: true,
    },
  });
  const selected = criterion({
    criterionId: "selected",
    taskId: parent.taskId,
    description: "The selected behavior works",
    required: true,
    status: options.status ?? "unsatisfied",
    satisfiedByEvidenceIds: options.ids ?? [],
    revision: 1,
    updatedAt: at,
    ...(options.status === "waived"
      ? {
          waiver: {
            reason: "Human decision",
            evidenceIds: [],
            specRevision: 2,
            waivedAt: at,
            attribution: human,
          },
        }
      : {}),
  });
  const { waiver: _waiver, ...unwaived } = selected;
  const other = criterion({
    ...unwaived,
    criterionId: "other",
    description: "Independent behavior",
    status: "unsatisfied",
    satisfiedByEvidenceIds: [],
  });
  const plan = record({
    kind: "plan-revision",
    recordId: "plan",
    projectId: target.projectId,
    status: "proposed",
    taskId: parent.taskId,
    specRevision: 2,
    planRevision: 3,
    content: "Retained plan",
    contentHash: "plan-hash",
    dependencyTaskIds: [],
    revision: 0,
    generation: 0,
    updatedAt: at,
  });
  if (plan.kind !== "plan-revision") throw new Error("Invalid controlled plan");
  const state = {
    ...emptyProjectWorkReducerState(target.projectId),
    tasks: [parent],
    criteria: [selected, other],
    foundationRecords: [plan],
  };
  const scopeHash = projectTeamScopeHash(state, parent.taskId, plan);
  const input = evidence({
    evidenceId: "input",
    taskId: parent.taskId,
    criterionId: selected.criterionId,
    kind: "observation",
    summary: "Observed",
    detail: "Exact selected input",
    scopeHash,
    recordedAt: at,
    revision: 0,
    attribution: human,
  });
  const testEvidence = evidence({
    evidenceId: verification.evidenceId,
    taskId: parent.taskId,
    kind: "test",
    summary: "Original test",
    detail: canonical({
      jobId: verification.jobId,
      manifestHash: verification.manifestHash,
      attemptId: verification.attemptId,
      resultHash: verification.resultHash,
      criteriaHash: "f".repeat(64),
      criterionCount: 1,
    }),
    scopeHash,
    recordedAt: at,
    revision: 0,
    attribution: human,
  });
  const applicability = record({
    kind: "evidence-applicability",
    recordId: verification.applicabilityId,
    projectId: target.projectId,
    taskId: parent.taskId,
    evidenceId: testEvidence.evidenceId,
    status: "current",
    specRevision: 2,
    planRevision: 3,
    repository: "/repo",
    worktree: "/worktree",
    testedTree: "t".repeat(40),
    testedCommit: target.headSha,
    baseSha: target.baseSha,
    headSha: target.headSha,
    command: "Controlled test",
    exitCode: 0,
    artifactId: "stdout",
    environmentSummary: "Controlled",
    integration: false,
    scopeHash,
    revision: 0,
    generation: 0,
    updatedAt: at,
  });
  const current: ProjectWorkReducerState = {
    ...state,
    evidence: [input, testEvidence],
    foundationRecords: [plan, applicability],
  };
  return { state: current, selected, other, input, plan };
}
function completed(
  state: ProjectWorkReducerState,
  verdict: "met" | "not-met" = "met",
  commandId = "proposal",
  inputIds: readonly string[] = ["input"],
) {
  const selected = state.criteria.find((c) => c.criterionId === "selected");
  if (!selected) throw new Error("Missing selected criterion");
  const plan = state.foundationRecords?.find((r) => r.kind === "plan-revision");
  if (plan?.kind !== "plan-revision") throw new Error("Missing original plan");
  const assessment = {
    criterionId: selected.criterionId,
    expectedRevision: selected.revision,
    verdict,
    detail: "Exact reviewer judgment",
    evidenceIds: inputIds,
  };
  const report = {
    type: "project-team.assignment.report",
    commandId,
    projectId: target.projectId,
    taskId: "review-child",
    expectedRevision: state.revision,
    expectedTaskRevision: 0,
    specRevision: 2,
    planRevision: 3,
    assignmentId: "review-assignment",
    expectedAssignmentRevision: 0,
    summary: "Completed review",
    evidenceIds: [],
    outputArtifactIds: [],
    outcome: "complete",
    criterionAssessments: [assessment],
  };
  const value = proof({
    status: "completed",
    proposalCommandId: commandId,
    proposalSha256: "0".repeat(64),
    assignmentOperationId: "review-operation",
    assignmentRequestHash: "1".repeat(64),
    assignmentReceiptSha256: "2".repeat(64),
    joinedReceiptId: settlement.joinedReceiptId,
    joinedEvidenceSha256: "3".repeat(64),
    report,
    reportAttribution: human,
    assignment: {
      kind: "task-membership",
      recordId: "review-assignment",
      projectId: target.projectId,
      status: "active",
      taskId: "review-child",
      parentTaskId: target.taskId,
      executionKind: "managed",
      deliverableKind: "review",
      revision: 0,
      generation: 0,
      updatedAt: at,
    },
    target,
    provenance: reviewer,
    criteria: [{ id: "child-criterion", revision: 0, sha256: "4".repeat(64) }],
    evidence: [],
    outputs: [],
    reportEvidenceId: "report-evidence",
    reportCommentId: "report-comment",
    findings: (state.foundationRecords ?? [])
      .flatMap((r) =>
        r.kind === "review-finding"
          ? [{ findingId: r.findingId, revision: r.revision, sha256: hash(r) }]
          : [],
      )
      .sort((a, b) => a.findingId.localeCompare(b.findingId)),
    parentAssessments: {
      verification,
      snapshots: [
        {
          assessmentSha256: hash(assessment),
          projectId: target.projectId,
          taskId: target.taskId,
          target,
          parentScopeHash: projectTeamScopeHash(state, target.taskId, plan),
          criterion: {
            id: selected.criterionId,
            revision: selected.revision,
            sha256: hash(selected),
          },
          evidence: inputIds.map((id) => {
            const entry = state.evidence.find((e) => e.evidenceId === id);
            if (!entry) throw new Error("Missing controlled evidence");
            return {
              id,
              taskId: target.taskId,
              ...(entry.criterionId === undefined ? {} : { criterionId: entry.criterionId }),
              scopeHash: entry.scopeHash,
              revision: entry.revision,
              sha256: hash(entry),
            };
          }),
        },
      ],
    },
  });
  if (value.status !== "completed") throw new Error("Invalid controlled completed proof");
  return value;
}
function prepare(state: ProjectWorkReducerState, completion = completed(state)) {
  return prepareReviewCriterionProgress({
    state,
    completion,
    settlementCommandId: settlement.commandId,
    settlementCommandFingerprint: settlement.commandFingerprint,
    at,
  });
}
function project(state: ProjectWorkReducerState, drafts: ReturnType<typeof prepare>) {
  const events = drafts.map((event, position) => ({
    ...event,
    eventId: EventId.make(`progress:${state.revision}:${position}`),
    projectId: state.projectId,
    revision: state.revision + position + 1,
  }));
  return { state: applyProjectWorkEvents(state, events), events };
}

it("positive progress changes only the selected criterion and does not invalidate itself", () => {
  const f = fixture();
  const drafts = prepare(f.state);
  expect(drafts.map((d) => d.type)).toEqual([
    "project-work.evidence.added",
    "project-work.criterion.upserted",
  ]);
  const after = project(f.state, drafts).state;
  expect(after.criteria.find((c) => c.criterionId === "selected")).toMatchObject({
    status: "satisfied",
    revision: 2,
  });
  expect(after.criteria.find((c) => c.criterionId === "other")).toEqual(f.other);
  expect(after.tasks).toEqual(f.state.tasks);
  expect(invalidateReviewCriterionProgress({ state: after, at })).toEqual([]);
});
for (const status of ["waived", "satisfied"] as const) {
  it(`qualified evidence preserves ${status} with no owned support`, () => {
    const f = fixture({ status });
    const after = project(f.state, prepare(f.state)).state;
    expect(after.evidence).toHaveLength(f.state.evidence.length + 1);
    expect(after.criteria).toEqual(f.state.criteria);
  });
}
it("stale review support is removed without erasing independent evidence", () => {
  const f = fixture({ status: "satisfied", ids: ["independent"] });
  const active = project(f.state, prepare(f.state)).state;
  const stale = {
    ...active,
    foundationRecords: (active.foundationRecords ?? []).map((r) =>
      r.kind === "evidence-applicability"
        ? { ...r, status: "stale" as const, revision: r.revision + 1 }
        : r,
    ),
  };
  const after = project(stale, invalidateReviewCriterionProgress({ state: stale, at })).state;
  expect(after.criteria.find((c) => c.criterionId === "selected")).toMatchObject({
    status: "satisfied",
    satisfiedByEvidenceIds: ["independent"],
  });
});
for (const drift of [
  "missing-test",
  "replaced-test",
  "malformed-test",
  "missing-applicability",
] as const) {
  it(`${drift} revokes owned support as durable input drift`, () => {
    const f = fixture();
    const active = project(f.state, prepare(f.state)).state;
    const changed =
      drift === "missing-applicability"
        ? {
            ...active,
            foundationRecords: (active.foundationRecords ?? []).filter(
              (r) => r.recordId !== verification.applicabilityId,
            ),
          }
        : {
            ...active,
            evidence: active.evidence.flatMap((entry) =>
              entry.evidenceId !== verification.evidenceId
                ? [entry]
                : drift === "missing-test"
                  ? []
                  : [
                      {
                        ...entry,
                        ...(drift === "replaced-test"
                          ? { kind: "observation" as const }
                          : { detail: "Malformed retained test" }),
                      },
                    ],
            ),
          };
    const after = project(changed, invalidateReviewCriterionProgress({ state: changed, at })).state;
    expect(after.criteria.find((c) => c.criterionId === "selected")).toMatchObject({
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
    });
  });
}
it("not-met retracts this target's owned support and cannot grant satisfaction", () => {
  const f = fixture();
  const active = project(f.state, prepare(f.state)).state;
  const negative = prepare(active, completed(active, "not-met", "negative-proposal"));
  const after = project(active, negative).state;
  expect(after.criteria.find((c) => c.criterionId === "selected")).toMatchObject({
    status: "unsatisfied",
    satisfiedByEvidenceIds: [],
  });
  expect(invalidateReviewCriterionProgress({ state: after, at })).toEqual([]);
});
for (const drift of ["definition", "scope", "input"] as const) {
  it(`${drift} drift removes only the affected producer support`, () => {
    const f = fixture();
    const active = project(f.state, prepare(f.state)).state;
    const changed =
      drift === "definition"
        ? {
            ...active,
            criteria: active.criteria.map((c) =>
              c.criterionId === "selected" ? { ...c, description: "Changed definition" } : c,
            ),
          }
        : drift === "scope"
          ? {
              ...active,
              tasks: active.tasks.map((t) => ({ ...t, specRevision: t.specRevision + 1 })),
            }
          : {
              ...active,
              evidence: active.evidence.map((e) =>
                e.evidenceId === "input" ? { ...e, detail: "Changed input" } : e,
              ),
            };
    const after = project(changed, invalidateReviewCriterionProgress({ state: changed, at })).state;
    expect(after.criteria.find((c) => c.criterionId === "selected")).toMatchObject({
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
    });
    expect(after.criteria.find((c) => c.criterionId === "other")).toEqual(f.other);
  });
}
function finding(criterionId: string, severity: "low" | "critical") {
  return record({
    kind: "review-finding",
    recordId: "finding-record",
    findingId: "finding",
    projectId: target.projectId,
    taskId: target.taskId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    severity,
    criterionIds: [criterionId],
    detail: "Observed finding",
    status: "open",
    resolutionArtifactIds: [],
    target,
    originReviewer: reviewer,
    reportedBy: reviewer,
  });
}
it("repaired-head resolution supports progress and receipt drift removes that support", () => {
  const original = finding("selected", "critical");
  if (original.kind !== "review-finding") throw new Error("Invalid finding fixture");
  const resolved = {
    ...original,
    target: { ...target, headSha: "old-head" },
    revision: 1,
    status: "resolved" as const,
    resolutionArtifactIds: ["stdout"],
  };
  const resolutionProof = decodeResolutionProof({
    version: 1,
    environmentId: verification.environmentId,
    prior: { revision: 0, sha256: "f".repeat(64) },
    target,
    reviewTargetSha256: reviewer.targetSha256,
    jobId: verification.jobId,
    manifestHash: verification.manifestHash,
    attemptId: verification.attemptId,
    resultHash: verification.resultHash,
    artifacts: [{ artifactId: "stdout", sha256: "a".repeat(64), byteCount: 4 }],
  });
  const receipt = prepareReviewFindingResolutionEvidence({
    finding: resolved,
    proof: resolutionProof,
    commandId: "resolution-command",
    at,
    attribution: human,
  });
  const initial = fixture().state;
  const state = {
    ...initial,
    foundationRecords: [...(initial.foundationRecords ?? []), resolved],
    evidence: [...initial.evidence, receipt],
  };
  const completion = completed(state);
  const exact = {
    ...completion,
    findings: [
      {
        findingId: resolved.findingId,
        revision: resolved.revision,
        sha256: hash({ finding: resolved, receipt }),
      },
    ],
  };
  expect(() => prepare(state, completion)).toThrow();
  const active = project(state, prepare(state, exact)).state;
  expect(active.criteria.find((c) => c.criterionId === "selected")?.status).toBe("satisfied");
  const missingReceipt = {
    ...active,
    evidence: active.evidence.filter((e) => e.evidenceId !== receipt.evidenceId),
  };
  const invalidated = invalidateReviewCriterionProgress({ state: missingReceipt, at });
  expect(invalidated).toHaveLength(1);
  expect(invalidated[0]?.criterion.status).toBe("unsatisfied");
  const changedReceipt = {
    ...active,
    evidence: active.evidence.map((e) =>
      e.evidenceId === receipt.evidenceId ? { ...e, summary: "Changed retained receipt" } : e,
    ),
  };
  expect(invalidateReviewCriterionProgress({ state: changedReceipt, at })).toHaveLength(1);
  const waived = {
    ...missingReceipt,
    criteria: missingReceipt.criteria.map((c) =>
      c.criterionId === "selected" ? { ...c, status: "waived" as const } : c,
    ),
  };
  expect(invalidateReviewCriterionProgress({ state: waived, at })).toEqual([]);
});
it("an unrelated low finding preserves support while a relevant finding invalidates it", () => {
  const active = project(fixture().state, prepare(fixture().state)).state;
  const unrelated = {
    ...active,
    foundationRecords: [...(active.foundationRecords ?? []), finding("other", "low")],
  };
  expect(invalidateReviewCriterionProgress({ state: unrelated, at })).toEqual([]);
  for (const entry of [finding("selected", "low"), finding("other", "critical")]) {
    const changed = { ...active, foundationRecords: [...(active.foundationRecords ?? []), entry] };
    expect(invalidateReviewCriterionProgress({ state: changed, at })).toHaveLength(1);
  }
});
it("removing a later finding never regrants invalidated support", () => {
  const f = fixture();
  const active = project(f.state, prepare(f.state)).state;
  const changed = {
    ...active,
    foundationRecords: [...(active.foundationRecords ?? []), finding("selected", "low")],
  };
  const revoked = project(changed, invalidateReviewCriterionProgress({ state: changed, at })).state;
  const resolved = { ...revoked, foundationRecords: active.foundationRecords ?? [] };
  expect(invalidateReviewCriterionProgress({ state: resolved, at })).toEqual([]);
  expect(resolved.criteria.find((c) => c.criterionId === "selected")?.status).toBe("unsatisfied");
});
it("replay audits the original criterion event after legitimate later invalidation", () => {
  const f = fixture();
  const active = project(f.state, prepare(f.state));
  const changed = {
    ...active.state,
    evidence: active.state.evidence.map((e) =>
      e.evidenceId === "input" ? { ...e, detail: "Changed input" } : e,
    ),
  };
  const revoked = project(changed, invalidateReviewCriterionProgress({ state: changed, at })).state;
  expect(() =>
    assertRetainedReviewCriterionProgress({ state: revoked, events: active.events, settlement }),
  ).not.toThrow();
  expect(() =>
    assertRetainedReviewCriterionProgress({
      state: revoked,
      events: active.events.filter((e) => e.type !== "project-work.criterion.upserted"),
      settlement,
    }),
  ).toThrow();
  expect(() =>
    assertRetainedReviewCriterionProgress({
      state: revoked,
      events: active.events,
      settlement: { ...settlement, commandFingerprint: "ffffffff" },
    }),
  ).toThrow();
});
it("legacy absent and explicit empty assessments emit no parent progress", () => {
  const f = fixture();
  const original = completed(f.state);
  if (original.report.type !== "project-team.assignment.report") throw new Error("Invalid report");
  const { criterionAssessments: _assessments, ...report } = original.report;
  const { parentAssessments: _parent, ...base } = original;
  expect(prepare(f.state, { ...base, report })).toEqual([]);
  expect(
    prepare(f.state, {
      ...original,
      report: { ...original.report, criterionAssessments: [] },
      parentAssessments: { ...original.parentAssessments!, snapshots: [] },
    }),
  ).toEqual([]);
  expect(() => prepare(f.state, base)).toThrow();
});
it("forged producer attribution fails closed instead of treating a generic detail as support", () => {
  const f = fixture();
  const active = project(f.state, prepare(f.state)).state;
  const forged = {
    ...active,
    evidence: active.evidence.map((e) => (e.kind === "review" ? { ...e, attribution: human } : e)),
  };
  expect(() => invalidateReviewCriterionProgress({ state: forged, at })).toThrow();
});
it("oversized canonical provenance is rejected before a progress plan escapes", () => {
  const f = fixture();
  const inputs = Array.from({ length: 64 }, (_, position) =>
    evidence({ ...f.input, evidenceId: "界".repeat(240) + position }),
  );
  const state = { ...f.state, evidence: [...f.state.evidence, ...inputs] };
  expect(() =>
    prepare(
      state,
      completed(
        state,
        "met",
        "bounded-proposal",
        inputs.map((e) => e.evidenceId),
      ),
    ),
  ).toThrow("Review progress provenance exceeds its evidence bound");
});
