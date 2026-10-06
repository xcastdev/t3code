import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  ProjectTeamGuidedIntent,
  ProjectWorkTeamTransition,
  ProjectTeamReviewCompletionProof,
  ProjectWorkExport,
  ProjectWorkMarkdownExport,
  ProjectWorkCriterionRead,
  ProjectWorkReadRecord,
  ProjectWorkReadIntent,
  ProjectWorkBoundedReadEnvelope,
  ProjectWorkTask,
  ProjectWorkTaskRead,
  ProjectWorkTaskCreateCommand,
  ProjectWorkIssueRefineCommand,
  ProjectWorkTaskSpecifyCommand,
  ProjectWorkTaskReviseProtectedSpecificationCommand,
  ProjectWorkDecisionSupersedeCommand,
  ProjectWorkTaskState,
  canonicalProjectWorkPayload,
  projectWorkPayloadFingerprint,
} from "./index.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeVerificationRead = Schema.decodeUnknownSync(ProjectWorkReadIntent);
const decodeVerificationRecord = Schema.decodeUnknownSync(ProjectWorkReadRecord);
const decodeVerificationEnvelope = Schema.decodeUnknownSync(ProjectWorkBoundedReadEnvelope);

const decodeTaskCreate = Schema.decodeUnknownSync(ProjectWorkTaskCreateCommand);
const decodeIssueRefine = Schema.decodeUnknownSync(ProjectWorkIssueRefineCommand);
const decodeTask = Schema.decodeUnknownSync(ProjectWorkTask);
const decodeTaskRead = Schema.decodeUnknownSync(ProjectWorkTaskRead);
const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

describe("project work contracts", () => {
  it("accepts a title-only draft command without a thread or provider", () => {
    const command = decodeTaskCreate({
      type: "project-work.task.create",
      commandId: "command-1",
      projectId: "project-1",
      taskId: "task-1",
      title: "Capture the release checklist",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(command.title).toBe("Capture the release checklist");
    expect(command.attribution).toBeUndefined();
    expect(command.summary).toBeUndefined();
  });

  it("requires exact project and issue revisions for each human refinement target", () => {
    const common = {
      type: "project-work.issue.refine",
      commandId: "refine-1",
      projectId: "project-1",
      expectedRevision: 2,
      issueRecordId: "issue-1",
      expectedIssueRevision: 1,
      refinedAt: "2026-01-01T00:00:00.000Z",
    };
    const targets = [
      { kind: "new-task", taskId: "task-1", title: "Investigate", deliverableKind: "code" },
      { kind: "existing-task", taskId: "task-2", expectedTaskRevision: 3 },
      { kind: "mission", title: "Release", objective: "Deliver the release" },
    ];
    for (const target of targets) {
      expect(decodeIssueRefine({ ...common, target })).toMatchObject({ ...common, target });
      expect(() => decodeIssueRefine({ ...common, expectedRevision: undefined, target })).toThrow();
      expect(() =>
        decodeIssueRefine({ ...common, expectedIssueRevision: undefined, target }),
      ).toThrow();
    }
    expect(() =>
      decodeIssueRefine({
        ...common,
        target: { kind: "existing-task", taskId: "task-2" },
      }),
    ).toThrow();
    expect(() =>
      decodeIssueRefine({
        ...common,
        target: { kind: "new-task", taskId: "task-1", title: "Investigate" },
      }),
    ).toThrow();
    expect(() =>
      decodeIssueRefine({
        ...common,
        target: { kind: "mission", title: "Release", objective: "x".repeat(32_001) },
      }),
    ).toThrow();
    expect(() =>
      decodeIssueRefine({ ...common, expectedIssueRevision: -1, target: targets[0] }),
    ).toThrow();
  });

  it("accepts additive revision envelopes, task context reads, and search record kinds", () => {
    expect(
      Schema.decodeUnknownSync(ProjectWorkReadIntent)({
        projectId: "project-1",
        operation: "task-context",
        taskId: "task-1",
      }),
    ).toMatchObject({ operation: "task-context", taskId: "task-1" });
    expect(
      Schema.decodeUnknownSync(ProjectWorkReadIntent)({
        projectId: "project-1",
        operation: "search",
        query: "lease",
        recordKinds: ["task", "knowledge"],
        envelope: true,
      }),
    ).toMatchObject({ recordKinds: ["task", "knowledge"], envelope: true });
    expect(
      Schema.decodeUnknownSync(ProjectWorkBoundedReadEnvelope)({
        projectId: "project-1",
        revision: 4,
        offset: 0,
        limit: 50,
        hasMore: false,
        items: [],
      }).revision,
    ).toBe(4);
  });

  it("bounds source-pinned lazy issue comment requests and preserves legacy reads", () => {
    const decode = Schema.decodeUnknownSync(ProjectWorkReadIntent);
    const input = {
      projectId: "project-1",
      operation: "issue-comments",
      issueRecordId: "issue-1",
      expectedIssueRevision: 0,
      issueCommentPage: 10_000,
    };
    expect(decode(input)).toMatchObject(input);
    expect(decode({ projectId: "project-1", operation: "tasks" }).operation).toBe("tasks");
    for (const patch of [
      { issueRecordId: "x".repeat(257) },
      { expectedIssueRevision: -1 },
      { expectedIssueRevision: 0.5 },
      { issueCommentPage: 0 },
      { issueCommentPage: 10_001 },
    ])
      expect(() => decode({ ...input, ...patch })).toThrow();
  });

  it("defaults new task writes to Draft while reads preserve future states", () => {
    const task = decodeTask({
      taskId: "task-1",
      projectId: "project-1",
      title: "Unspecified task",
      revision: 0,
      specRevision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(task.state).toBe("draft");

    const read = decodeTaskRead({
      ...task,
      state: "future-state",
    });
    expect(read.state).toBe("future-state");
  });

  it("preserves future discriminators and nested attribution in read records", () => {
    const futureAttribution = {
      actor: { kind: "future-actor", id: "actor-1" },
      source: { kind: "future-source", id: "source-1" },
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    const task = decodeTaskRead({
      taskId: "task-1",
      projectId: "project-1",
      title: "Future task",
      state: "future-task-state",
      failureKind: "future-failure-kind",
      revision: 0,
      specRevision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      attribution: futureAttribution,
    });
    expect(task.state).toBe("future-task-state");
    expect(task.failureKind).toBe("future-failure-kind");
    expect(task.attribution).toEqual(futureAttribution);

    const criterion = Schema.decodeUnknownSync(ProjectWorkCriterionRead)({
      criterionId: "criterion-1",
      taskId: "task-1",
      description: "Future criterion",
      required: true,
      status: "future-criterion-status",
      satisfiedByEvidenceIds: [],
      waiver: {
        reason: "Future waiver",
        evidenceIds: [],
        specRevision: 0,
        waivedAt: "2026-01-01T00:00:00.000Z",
        attribution: futureAttribution,
      },
      revision: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(criterion.status).toBe("future-criterion-status");
    expect(criterion.waiver?.attribution).toEqual(futureAttribution);
    const record = Schema.decodeUnknownSync(ProjectWorkReadRecord)(criterion);
    expect("status" in record && record.status).toBe("future-criterion-status");
  });

  it("keeps write intents closed", () => {
    expect(() =>
      decodeTaskCreate({
        type: "project-work.task.erase",
        commandId: "command-1",
        projectId: "project-1",
        taskId: "task-1",
        title: "invalid",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeClientCommand({
        type: "project-work.task.erase",
        commandId: "command-1",
        projectId: "project-1",
        taskId: "task-1",
        title: "invalid",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeTask({
        taskId: "task-1",
        projectId: "project-1",
        title: "invalid future state",
        state: "future-state",
        revision: 0,
        specRevision: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("requires non-empty specification fields and at least one criterion", () => {
    const decodeSpecify = Schema.decodeUnknownSync(ProjectWorkTaskSpecifyCommand);
    expect(() =>
      decodeSpecify({
        type: "project-work.task.specify",
        commandId: "command-1",
        projectId: "project-1",
        taskId: "task-1",
        specification: {
          objective: "",
          scopeIn: "files",
          scopeOut: "nothing",
          criterionIds: [],
          revision: 1,
          protected: false,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts only explicitly bound protected revision intents", () => {
    const command = Schema.decodeUnknownSync(ProjectWorkTaskReviseProtectedSpecificationCommand)({
      type: "project-work.task.revise-protected-specification",
      commandId: "command-protected-revision",
      projectId: "project-1",
      taskId: "task-1",
      specification: {
        objective: "Ship the revised feature",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: ["criterion-1"],
        revision: 2,
        protected: true,
      },
      criterionSnapshots: [
        {
          criterionId: "criterion-1",
          taskId: "task-1",
          description: "Criterion 1",
          required: true,
          status: "unsatisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      affectedResultIds: ["result-1"],
      approval: {
        approvalId: "approval-1",
        taskId: "task-1",
        specRevision: 2,
        payloadFingerprint: "fingerprint-1",
        approvedAt: "2026-01-01T00:00:00.000Z",
        attribution: {
          actor: { kind: "human", id: "human-1" },
          source: { kind: "web", id: "client-1" },
          recordedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      revisedAt: "2026-01-01T00:00:00.000Z",
      attribution: {
        actor: { kind: "agent", id: "agent-1" },
        source: { kind: "mcp", id: "mcp-1" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(command.affectedResultIds).toEqual(["result-1"]);
    expect(command.criterionSnapshots).toHaveLength(1);
    expect(() =>
      Schema.decodeUnknownSync(ProjectWorkTaskReviseProtectedSpecificationCommand)({
        ...command,
        type: "project-work.task.revise-protected-specification.unknown",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(ProjectWorkTaskRead)({
        taskId: "task-1",
        projectId: "project-1",
        title: "Missing state",
        revision: 0,
        specRevision: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("canonicalizes full approval payloads and changes their fingerprint when any field changes", () => {
    const first = {
      projectId: "project-1",
      taskId: "task-1",
      specification: { revision: 2 },
      affectedResultIds: ["result-1"],
    };
    const reordered = {
      affectedResultIds: ["result-1"],
      specification: { revision: 2 },
      taskId: "task-1",
      projectId: "project-1",
    };
    expect(canonicalProjectWorkPayload(first)).toBe(canonicalProjectWorkPayload(reordered));
    expect(projectWorkPayloadFingerprint(first)).not.toBe(
      projectWorkPayloadFingerprint({ ...first, affectedResultIds: ["result-2"] }),
    );
  });

  it("requires markdown exports to declare that they are non-authoritative", () => {
    const exportValue = Schema.decodeUnknownSync(ProjectWorkMarkdownExport)({
      format: "markdown",
      projectId: "project-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      authoritative: false,
      contents: "# Work",
    });
    expect(exportValue.authoritative).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(ProjectWorkMarkdownExport)({
        ...exportValue,
        authoritative: true,
      }),
    ).toThrow();
  });

  it("keeps JSON export versioned and redaction-aware", () => {
    const value = Schema.decodeUnknownSync(ProjectWorkExport)({
      schemaVersion: 1,
      format: "json",
      environmentId: "environment-1",
      projectId: "project-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      projectRevision: 4,
      tasks: [],
      attempts: [],
      criteria: [],
      evidence: [],
      relationships: [],
      blockers: [],
      checkpoints: [],
      attention: [],
      knowledge: [],
      decisions: [],
      comments: [],
      redactions: ["secret.token"],
    });
    expect(value.schemaVersion).toBe(1);
    expect(value.redactions).toEqual(["secret.token"]);
  });

  it("retains future values in exports but rejects malformed elements", () => {
    const task = {
      taskId: "task-1",
      projectId: "project-1",
      title: "Future task",
      state: "future-task-state",
      failureKind: "future-failure-kind",
      revision: 0,
      specRevision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const input = {
      schemaVersion: 1,
      format: "json",
      environmentId: "environment-1",
      projectId: "project-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      projectRevision: 4,
      tasks: [task],
      attempts: [],
      criteria: [],
      evidence: [],
      relationships: [],
      blockers: [],
      checkpoints: [],
      attention: [],
      knowledge: [],
      decisions: [],
      comments: [],
      redactions: [],
    };
    const value = Schema.decodeUnknownSync(ProjectWorkExport)(input);
    expect(value.tasks[0]?.state).toBe("future-task-state");
    expect(value.tasks[0]?.failureKind).toBe("future-failure-kind");
    const encoded = Schema.encodeSync(ProjectWorkExport)(value);
    expect(encoded.tasks[0]?.state).toBe("future-task-state");
    expect(encoded.tasks[0]?.failureKind).toBe("future-failure-kind");

    expect(() =>
      Schema.decodeUnknownSync(ProjectWorkExport)({
        ...input,
        tasks: [{ ...task, revision: "not-a-revision" }],
      }),
    ).toThrow();
  });

  it("defaults the environment opt-in off and accepts an explicit patch", () => {
    expect(DEFAULT_SERVER_SETTINGS.projectWorkEnabled).toBe(false);
    expect(Schema.decodeUnknownSync(ServerSettings)({}).projectWorkEnabled).toBe(false);
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ projectWorkEnabled: true })
        .projectWorkEnabled,
    ).toBe(true);
  });

  it("keeps the lifecycle enum closed", () => {
    expect(Schema.is(ProjectWorkTaskState)("ready")).toBe(true);
    expect(Schema.is(ProjectWorkTaskState)("not-a-state")).toBe(false);
  });

  it("requires attribution on decision supersession commands", () => {
    const decodeSupersede = Schema.decodeUnknownSync(ProjectWorkDecisionSupersedeCommand);
    const command = {
      type: "project-work.decision.supersede",
      commandId: "command-supersede",
      projectId: "project-1",
      decisionId: "decision-1",
      replacement: {
        decisionId: "decision-2",
        projectId: "project-1",
        title: "Replacement",
        body: "New proposal",
        state: "proposed",
        revision: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      supersededAt: "2026-01-01T00:00:00.000Z",
      attribution: {
        actor: { kind: "human", id: "human-1" },
        source: { kind: "web", id: "client-1" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(decodeSupersede(command).attribution.actor.kind).toBe("human");
    expect(() => decodeSupersede({ ...command, attribution: undefined })).toThrow();
  });
});

const decodeOpaqueWorkRead = Schema.decodeUnknownSync(ProjectWorkReadIntent);
const encodeOpaqueWorkRead = Schema.encodeSync(ProjectWorkReadIntent);

it("round-trips opaque foundation request cursors without changing their bytes", () => {
  for (const cursor of [" page-one ", "\tpage-two\n", " ", "x".repeat(4000)]) {
    const input = { projectId: "project", operation: "foundation-records", cursor };
    expect(encodeOpaqueWorkRead(decodeOpaqueWorkRead(input))).toEqual(input);
  }
  for (const cursor of ["", "x".repeat(4001)]) {
    expect(() =>
      decodeOpaqueWorkRead({ projectId: "project", operation: "foundation-records", cursor }),
    ).toThrow();
  }
});

it("addresses one verification preview by project, task and exact job ID rather than a generic search", () => {
  const intent = {
    projectId: "project",
    taskId: "task",
    operation: "verification-job",
    verificationJobId: "verification-job",
  };
  const decode = decodeVerificationRead;
  expect(decode(intent)).toEqual(intent);
  for (const change of [
    { verificationJobId: undefined },
    { verificationJobId: "" },
    { verificationJobId: " job " },
    { verificationJobId: "x".repeat(257) },
    { taskId: undefined },
    { taskId: "" },
    { taskId: "x".repeat(257) },
    { query: "verification-job" },
    { state: "approved" },
  ])
    expect(() => decode({ ...intent, ...change })).toThrow();
  expect(
    decode({ projectId: "project", operation: "search", query: "existing search" }),
  ).toMatchObject({ query: "existing search" });
});

const previewCommand = {
  executable: "/opt/project tools/test runner",
  argv: ["", "  preserved  ", "--filter", "$(literal); *", "line\nbreak"],
  limits: { maxDurationMs: 120_000, maxOutputBytes: 65_536 },
  environment: "clean",
};

const previewManifest = {
  version: 1,
  jobId: "verification-1",
  environmentId: "environment",
  projectId: "project",
  taskId: "task",
  specRevision: 4,
  specificationHash: "a".repeat(64),
  planRevision: 2,
  planHash: "b".repeat(64),
  criteria: [{ criterionId: "criterion-1", revision: 3 }],
  dispatchId: "original-implementation",
  bindingId: "implementation-binding",
  generation: 7,
  workspaceReceiptHash: "c".repeat(64),
  command: previewCommand,
  target: {
    repository: "/project",
    worktree: "/project-worktree",
    branchRef: "refs/heads/team/implementation",
    baseSha: "d".repeat(40),
    headSha: "e".repeat(40),
    testedCommit: "e".repeat(40),
    testedTree: "f".repeat(40),
    workspaceState: "clean-committed",
  },
  executable: {
    target: previewCommand.executable,
    sha256: "1".repeat(64),
    runtimeClosureSha256: "2".repeat(64),
  },
};

it("retains a bounded typed verification preview through the shared read record and pagination envelope", () => {
  const record = { kind: "verification-job", manifest: previewManifest, sha256: "3".repeat(64) };
  const decode = decodeVerificationRecord;
  expect(decode(record)).toEqual(record);
  const envelope = decodeVerificationEnvelope({
    projectId: "project",
    revision: 5,
    offset: 0,
    limit: 1,
    hasMore: false,
    items: [record],
  });
  expect(decode(envelope.items[0])).toEqual(record);
  for (const change of [
    { sha256: "A".repeat(64) },
    { sha256: "3".repeat(63) },
    { manifest: { ...previewManifest, version: 2 } },
    { manifest: { ...previewManifest, criteria: [] } },
    { manifest: { ...previewManifest, command: { ...previewCommand, environment: "inherit" } } },
    {
      manifest: {
        ...previewManifest,
        executable: { ...previewManifest.executable, target: "/other" },
      },
    },
  ])
    expect(() => decode({ ...record, ...change })).toThrow();
  const path = "/" + "界".repeat(4_095);
  expect(() =>
    decode({
      ...record,
      manifest: {
        ...previewManifest,
        target: { ...previewManifest.target, repository: path, worktree: path },
        command: { ...previewCommand, executable: path, argv: Array(4).fill("x".repeat(4_096)) },
        executable: { ...previewManifest.executable, target: path },
      },
    }),
  ).toThrow();
});

describe("private verification consumption contract", () => {
  const decode = Schema.decodeUnknownSync(ProjectWorkTeamTransition, { onExcessProperty: "error" });
  const transition = {
    kind: "verification.claim",
    taskId: "task",
    expectedTaskRevision: 1,
    gateId: "gate",
    expectedGateRevision: 0,
    jobId: "job",
    manifestHash: "a".repeat(64),
    attemptId: "attempt",
  };
  it("accepts an exact consumption target without executable or result authority", () => {
    expect(decode(transition)).toEqual(transition);
  });
  it("rejects malformed digests, counters and extra authority", () => {
    for (const input of [
      { ...transition, manifestHash: "A".repeat(64) },
      { ...transition, manifestHash: "a".repeat(63) },
      { ...transition, expectedTaskRevision: -1 },
      { ...transition, expectedGateRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...transition, executable: "/bin/bash" },
      { ...transition, success: true },
    ])
      expect(() => decode(input)).toThrow();
  });
});

const reviewProofReport = {
  type: "project-team.assignment.report",
  commandId: "report-command",
  projectId: "project",
  taskId: "review-child",
  expectedRevision: 1,
  expectedTaskRevision: 1,
  specRevision: 1,
  planRevision: 1,
  assignmentId: "membership",
  expectedAssignmentRevision: 0,
  summary: "Reviewed the original target",
  evidenceIds: [],
  outputArtifactIds: [],
  outputs: [
    { criterionId: "review-criterion", kind: "observation", detail: "Checked original changes" },
  ],
  outcome: "complete",
};
const decodeAssessmentReport = Schema.decodeUnknownSync(ProjectTeamGuidedIntent, {
  onExcessProperty: "error",
});
const criterionAssessment = {
  criterionId: "parent-criterion",
  expectedRevision: 1,
  verdict: "met",
  detail: "Checked the current criterion",
  evidenceIds: ["parent-evidence"],
};
it("criterion assessments retain explicit judgments only in complete reports", () => {
  const report = { ...reviewProofReport, criterionAssessments: [criterionAssessment] };
  expect(decodeAssessmentReport(report)).toEqual(report);
  expect(decodeAssessmentReport(reviewProofReport)).toEqual(reviewProofReport);
  expect(() => decodeAssessmentReport({ ...report, outcome: "findings" })).toThrow();
  expect(() => decodeAssessmentReport({ ...report, outcome: "review-ready" })).toThrow();
  expect(() =>
    decodeAssessmentReport({
      ...report,
      criterionAssessments: [{ ...criterionAssessment, evidenceIds: [] }],
    }),
  ).toThrow();
  expect(
    decodeAssessmentReport({
      ...report,
      criterionAssessments: [{ ...criterionAssessment, verdict: "not-met", evidenceIds: [] }],
    }),
  ).toEqual({
    ...report,
    criterionAssessments: [{ ...criterionAssessment, verdict: "not-met", evidenceIds: [] }],
  });
});
it("criterion assessments reject ambiguous identities, unsafe revisions, excess authority and byte overflow", () => {
  for (const criterionAssessments of [
    [criterionAssessment, criterionAssessment],
    [{ ...criterionAssessment, expectedRevision: -1 }],
    [{ ...criterionAssessment, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...criterionAssessment, evidenceIds: ["parent-evidence", "parent-evidence"] }],
    [{ ...criterionAssessment, parentTaskId: "caller-selected-parent" }],
    Array.from({ length: 65 }, (_, i) => ({
      ...criterionAssessment,
      criterionId: `criterion-${i}`,
    })),
    Array.from({ length: 2 }, (_, i) => ({
      ...criterionAssessment,
      criterionId: `criterion-${i}`,
      detail: "界".repeat(32000),
    })),
  ])
    expect(() => decodeAssessmentReport({ ...reviewProofReport, criterionAssessments })).toThrow();
});
const proofHash = "a".repeat(64);
const reviewCompletionProof = {
  status: "completed",
  proposalCommandId: "report-command",
  proposalSha256: proofHash,
  assignmentOperationId: "assignment-operation",
  assignmentRequestHash: proofHash,
  assignmentReceiptSha256: proofHash,
  joinedReceiptId: "joined-receipt",
  joinedEvidenceSha256: proofHash,
  report: reviewProofReport,
  reportAttribution: {
    actor: { kind: "agent", id: "review-agent" },
    source: { kind: "mcp", id: "worker" },
    recordedAt: "2026-10-06T00:00:00.000Z",
  },
  assignment: {
    kind: "task-membership",
    projectId: "project",
    recordId: "membership",
    revision: 0,
    generation: 0,
    updatedAt: "2026-10-06T00:00:00.000Z",
    status: "active",
    taskId: "review-child",
    executionKind: "managed",
    deliverableKind: "review",
    parentTaskId: "parent",
  },
  target: {
    projectId: "project",
    taskId: "parent",
    specRevision: 1,
    planRevision: 1,
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  },
  provenance: {
    reviewTaskId: "review-child",
    bindingId: "binding",
    generation: 0,
    memberId: "member",
    providerInstanceId: "pi",
    threadId: "thread",
    sessionId: "session",
    initializeOperationId: "initialize-operation",
    dispatchId: "dispatch",
    targetSha256: proofHash,
  },
  criteria: [{ id: "review-criterion", revision: 0, sha256: proofHash }],
  evidence: [],
  outputs: [{ evidenceId: "derived-output", criterionId: "review-criterion", sha256: proofHash }],
  reportEvidenceId: "derived-report-evidence",
  reportCommentId: "derived-report-comment",
  findings: [],
};

it("review completion proof requires a complete typed report and rejects credentials or a bare grant", () => {
  const decode = Schema.decodeUnknownSync(ProjectTeamReviewCompletionProof);
  expect(decode(reviewCompletionProof)).toEqual(reviewCompletionProof);
  for (const changed of [
    true,
    { status: "completed", proposalSha256: proofHash },
    { ...reviewCompletionProof, credential: "must-not-cross-this-boundary" },
    { ...reviewCompletionProof, report: { ...reviewProofReport, outcome: "findings" } },
    { ...reviewCompletionProof, assignmentReceiptSha256: "invalid" },
    {
      ...reviewCompletionProof,
      criteria: Array.from({ length: 65 }, (_, index) => ({
        id: `criterion-${index}`,
        revision: 0,
        sha256: proofHash,
      })),
    },
  ])
    expect(() => decode(changed)).toThrow();
  const denied = {
    status: "denied",
    proposalCommandId: "report-command",
    proposalSha256: proofHash,
    assignmentOperationId: "assignment-operation",
    reason: "stale-proof",
  };
  expect(decode(denied)).toEqual(denied);
  expect(() => decode({ ...denied, reason: "" })).toThrow();
});

it("review completion proof enforces its total UTF8 byte bound across valid bounded fields", () => {
  const decode = Schema.decodeUnknownSync(ProjectTeamReviewCompletionProof);
  const id = (index: number) => "界".repeat(240) + index;
  const snapshots = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: id(index),
      revision: 0,
      sha256: proofHash,
    }));
  const oversized = {
    ...reviewCompletionProof,
    report: { ...reviewProofReport, summary: "界".repeat(32000) },
    criteria: snapshots(64),
    evidence: snapshots(128),
    findings: Array.from({ length: 256 }, (_, index) => ({
      findingId: id(index),
      revision: 0,
      sha256: proofHash,
    })),
    outputs: Array.from({ length: 64 }, (_, index) => ({
      evidenceId: id(index),
      criterionId: id(index),
      sha256: proofHash,
    })),
  };
  expect(new TextEncoder().encode(canonicalProjectWorkPayload(oversized)).length).toBeGreaterThan(
    524288,
  );
  expect(() => decode(oversized)).toThrow();
});
