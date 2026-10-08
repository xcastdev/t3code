import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectTeamCredential,
  ProjectTeamIntegrationSourceRefs,
  ProjectTeamWriteIntent,
  ProjectTeamRecord,
  ProjectTeamRecordRead,
  ProjectTeamRecordPage,
  PROJECT_TEAM_DEFAULT_LIMITS,
} from "./projectTeams.ts";
import {
  ProjectTeamGuidedIntent,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkWriteIntent,
  ProjectWorkTeamTransition,
  ProjectWorkEvidence,
} from "./projectWork.ts";

const decodeCredential = Schema.decodeUnknownSync(ProjectTeamCredential);
const decodeIntent = Schema.decodeUnknownSync(ProjectTeamWriteIntent);
const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeTeamRecordRead = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeGuided = Schema.decodeUnknownSync(ProjectTeamGuidedIntent);
const decodeFoundation = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const decodePublicWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const decodeTeamTransition = Schema.decodeUnknownSync(ProjectWorkTeamTransition);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence);
const member = {
  kind: "member",
  recordId: "member",
  projectId: "project",
  revision: 0,
  generation: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "active",
  name: "Coordinator",
  coordinator: true,
  roleRevisionId: "role",
};
describe("team contracts", () => {
  it("accepts explicit recipient task messages without caller identity or delivery authority", () => {
    const request = {
      type: "project-team.message.send",
      commandId: "send-one",
      projectId: "project",
      taskId: "sender-task",
      expectedRevision: 3,
      expectedTaskRevision: 1,
      specRevision: 1,
      planRevision: 1,
      messageId: "message",
      recipientId: "peer",
      recipientTaskId: "peer-task",
      expectedRecipientMembershipRevision: 2,
      body: "Informational update",
      evidenceIds: [],
    };
    expect(decodeIntent(request)).toEqual(request);
    expect(decodeIntent({ ...request, replyTo: "incoming" })).toEqual({
      ...request,
      replyTo: "incoming",
    });
    for (const change of [
      { senderId: "forged" },
      { generation: 4 },
      { status: "delivered" },
      { attribution: {} },
      { recipientTaskId: undefined },
      { expectedRecipientMembershipRevision: -1 },
      { body: "x".repeat(32001) },
      { evidenceIds: Array.from({ length: 65 }, (_, i) => `e-${i}`) },
    ])
      expect(() => decodeIntent({ ...request, ...change })).toThrow();
  });
  it("accepts bounded human-question requests without caller identity or approval fields", () => {
    const request = {
      type: "project-team.question.request",
      commandId: "ask-human",
      projectId: "project",
      taskId: "task",
      expectedRevision: 3,
      expectedTaskRevision: 1,
      specRevision: 1,
      planRevision: 1,
      questionId: "question",
      targetGateId: "gate",
      expectedGateRevision: 2,
      body: "Which bounded option should the worker use?",
      choices: ["Keep history", "Revise plan"],
    };
    expect(decodeIntent(request)).toEqual(request);
    for (const change of [
      { senderId: "caller" },
      { generation: 9 },
      { attribution: { actor: { kind: "human", id: "caller" } } },
      { response: "approved" },
      { expectedGateRevision: -1 },
      { body: "x".repeat(32001) },
      { choices: Array.from({ length: 65 }, (_, i) => `choice-${i}`) },
      { choices: ["x".repeat(257)] },
    ])
      expect(() => decodeIntent({ ...request, ...change })).toThrow();
  });
  it("preserves future read statuses while rejecting them for writes", () => {
    expect(decodeTeamRecordRead({ ...member, status: "sleeping" }).status).toBe("sleeping");
    expect(() => decodeTeamRecord({ ...member, status: "sleeping" })).toThrow();
  });
  it("bounds instructions and uses conservative product repair defaults", () => {
    expect(() => decodeTeamRecord({ ...member, name: "x".repeat(4001) })).toThrow();
    expect(PROJECT_TEAM_DEFAULT_LIMITS).toEqual({
      environmentModelCalls: 2,
      projectWritableWorkers: 1,
      delegationDepth: 2,
      repairAllowance: 2,
    });
  });
});

it("preserves safe metadata for unknown future record kinds", () => {
  expect(
    decodeTeamRecordRead({
      ...member,
      kind: "future-record",
      status: "future-state",
      payload: "Summary",
    }),
  ).toMatchObject({ kind: "future-record", status: "future-state", recordId: "member" });
  expect(() => decodeTeamRecord({ ...member, kind: "future-record" })).toThrow();
});

it("accepts an exact managed marker and only typed public gate responses", () => {
  const credential = {
    projectId: "project",
    bindingId: "binding",
    generation: 7,
    providerInstanceId: "pi",
    threadId: "thread",
  };
  expect(decodeCredential(credential)).toEqual(credential);
  expect(() => decodeCredential({ ...credential, generation: -1 })).toThrow();
  const intent = {
    type: "project-team.gate.respond",
    commandId: "response",
    projectId: "project",
    taskId: "task",
    expectedRevision: 1,
    expectedTaskRevision: 1,
    specRevision: 1,
    planRevision: 0,
    gateId: "gate",
    expectedGateRevision: 0,
    response: "approved",
  };
  expect(decodeIntent(intent)).toEqual(intent);
  expect(() => decodeIntent({ ...intent, response: "consumed" })).toThrow();
  expect(() => decodeIntent({ ...intent, expectedGateRevision: -1 })).toThrow();
});

describe("guided contract preparation", () => {
  const investigation = {
    type: "project-team.investigation.start",
    commandId: "investigate",
    projectId: "project",
    taskId: "task",
    expectedRevision: 0,
    expectedTaskRevision: 0,
    objective: "Investigate the reported failure",
    outputDescriptions: ["Reproduction and bounded findings"],
  };

  it("represents pre-spec investigation without invented approval revisions", () => {
    expect(decodeGuided(investigation)).toEqual(investigation);
    expect(() => decodeGuided({ ...investigation, expectedTaskRevision: undefined })).toThrow();
    expect(() => decodeGuided({ ...investigation, outputDescriptions: [] })).toThrow();
    expect(() =>
      decodeGuided({ ...investigation, outputDescriptions: Array(17).fill("Output") }),
    ).toThrow();
    expect(() => decodeGuided({ ...investigation, objective: "x".repeat(32_001) })).toThrow();
    expect(() => decodeGuided({ ...investigation, issueRecordId: "issue" })).toThrow();
    expect(() => decodeGuided({ ...investigation, expectedIssueRevision: 0 })).toThrow();
  });

  it("bounds inherited planner and reviewer requests without allowing a self-approved grant", () => {
    const planning = {
      ...investigation,
      type: "project-team.assignment.start",
      assignmentKind: "planning",
      specRevision: 1,
      specificationGateId: "approved-spec",
      expectedSpecificationGateRevision: 1,
    };
    expect(decodePublicWrite(planning)).toEqual(planning);
    expect(() => decodeGuided({ ...planning, assignmentKind: "review" })).toThrow();
    const review = {
      ...planning,
      assignmentKind: "review",
      parentPlan: {
        recordId: "plan",
        expectedRecordRevision: 0,
        planRevision: 1,
        gateId: "approved-plan",
        expectedGateRevision: 1,
      },
    };
    expect(decodeGuided(review)).toEqual(review);
    expect(() => decodeGuided({ ...planning, assignmentKind: "implementer" })).toThrow();
    expect(() => decodeGuided({ ...planning, assignmentAuthorization: {} })).toThrow();
    expect(() => decodeGuided({ ...planning, objective: "x".repeat(32_001) })).toThrow();
    expect(() => decodeGuided({ ...planning, outputDescriptions: [] })).toThrow();
    expect(() =>
      decodeGuided({ ...planning, outputDescriptions: ["Plan", "Another output"] }),
    ).toThrow();
    expect(() =>
      decodeGuided({ ...review, parentPlan: { ...review.parentPlan, actor: "human" } }),
    ).toThrow();
  });

  it("accepts the bounded public intent without caller-created authority", () => {
    expect(decodePublicWrite(investigation)).toEqual(investigation);
  });

  it("rejects excess authority at the default public decoder before it can strip fields", () => {
    for (const authority of [
      { actor: { kind: "human", id: "invented" } },
      { bindingId: "invented" },
      { generation: 99 },
      { authorizationGateId: "invented" },
    ]) {
      expect(() => decodePublicWrite({ ...investigation, ...authority })).toThrow();
      expect(() => decodeGuided({ ...investigation, ...authority })).toThrow();
    }
    expect(() =>
      decodePublicWrite({
        type: "project-team.task.control",
        commandId: "control",
        projectId: "project",
        taskId: "task",
        expectedRevision: 0,
        expectedTaskRevision: 0,
        control: { action: "pause", reason: "Stop", generation: 99 },
      }),
    ).toThrow();
    expect(() =>
      decodePublicWrite({
        type: "project-team.gate.respond",
        commandId: "approve",
        projectId: "project",
        taskId: "task",
        expectedRevision: 0,
        expectedTaskRevision: 0,
        specRevision: 1,
        planRevision: 0,
        gateId: "gate",
        expectedGateRevision: 0,
        response: "approved",
        actor: { kind: "human", id: "invented" },
      }),
    ).toThrow();
  });

  it("preserves legitimate legacy command attribution through the public decoder", () => {
    const command = {
      type: "project-work.task.create",
      commandId: "legacy-create",
      projectId: "project",
      taskId: "legacy-task",
      title: "Legacy capture",
      createdAt: "2026-01-01T00:00:00.000Z",
      attribution: {
        actor: { kind: "human", id: "user" },
        source: { kind: "web", id: "browser" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(decodePublicWrite(command)).toEqual(command);
  });

  it("retains the nonempty raw foundation invariant", () => {
    const command = {
      type: "project-work.foundation.commit",
      commandId: "investigate",
      projectId: "project",
      expectedRevision: 0,
      attribution: {
        actor: { kind: "human", id: "user" },
        source: { kind: "web", id: "client" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [],
      committedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => decodeFoundation(command)).toThrow();
    expect(
      decodeFoundation({ ...command, guided: { intent: investigation } }).guided?.intent,
    ).toEqual(investigation);
  });

  it("requires a concrete successor and report target", () => {
    const fields = {
      commandId: "control",
      projectId: "project",
      taskId: "task",
      expectedRevision: 0,
      expectedTaskRevision: 0,
    };
    expect(() =>
      decodeGuided({
        ...fields,
        type: "project-team.task.control",
        control: { action: "reassign", reason: "Replace the stopped worker" },
      }),
    ).toThrow();
    expect(() =>
      decodeGuided({
        ...fields,
        type: "project-team.assignment.report",
        specRevision: 0,
        planRevision: 0,
        summary: "Findings",
        evidenceIds: [],
        outputArtifactIds: [],
        outcome: "complete",
      }),
    ).toThrow();
  });

  it("rejects mixing private runtime transitions with guided or raw records", () => {
    const transition = {
      kind: "failure",
      bindingId: "binding",
      generation: 1,
      expectedBindingRevision: 0,
      failureFingerprint: "failure",
      relevantRevision: "revision",
      failureKind: "semantic",
      summary: "Recorded failure",
    };
    const command = {
      type: "project-work.foundation.commit",
      commandId: "failure",
      projectId: "project",
      expectedRevision: 0,
      attribution: {
        actor: { kind: "system" },
        source: { kind: "system" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [],
      transition,
      committedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeFoundation(command).transition?.kind).toBe("failure");
    expect(() => decodeFoundation({ ...command, guided: { intent: investigation } })).toThrow();
    expect(() => decodeFoundation({ ...command, records: [member] })).toThrow();
    const repair = {
      kind: "repair.consume",
      episodeId: "episode",
      expectedEpisodeRevision: 0,
      bindingId: "binding",
      generation: 1,
      relevantRevision: "revision",
      exceptionGateId: "exception",
    };
    expect(() => decodeTeamTransition(repair)).toThrow();
    // The legacy public union includes raw foundation commands; the gateway denies them.
    expect(decodePublicWrite(command).type).toBe("project-work.foundation.commit");
  });

  it("retains scoped non-code outputs without requiring fabricated Git fields", () => {
    const evidence = {
      evidenceId: "artifact",
      taskId: "task",
      kind: "artifact",
      summary: "Research findings",
      detail: "The bounded findings are retained here",
      scopeHash: "current-scope",
      outputArtifactIds: ["source-artifact"],
      recordedAt: "2026-01-01T00:00:00.000Z",
      revision: 0,
    };
    expect(decodeEvidence(evidence)).toEqual(evidence);
    expect(() =>
      decodeEvidence({ ...evidence, outputArtifactIds: Array(65).fill("artifact") }),
    ).toThrow();
    expect(() => decodeEvidence({ ...evidence, scopeHash: " " })).toThrow();
  });

  it("bounds retained findings by UTF-8 bytes across all declared outputs", () => {
    const report = {
      commandId: "report",
      projectId: "project",
      taskId: "task",
      expectedRevision: 0,
      expectedTaskRevision: 0,
      type: "project-team.assignment.report",
      specRevision: 1,
      planRevision: 0,
      assignmentId: "assignment",
      expectedAssignmentRevision: 0,
      summary: "Findings",
      evidenceIds: [],
      outputArtifactIds: [],
      outcome: "findings",
    };
    const outputs = [0, 1, 2].map((index) => ({
      criterionId: "criterion-" + index,
      kind: "observation",
      detail: "é".repeat(24_000),
    }));
    expect(decodeGuided({ ...report, outputs: outputs.slice(0, 2) }).type).toBe(report.type);
    expect(() => decodeGuided({ ...report, outputs })).toThrow();
    expect(() => decodeGuided({ ...report, outputs: [{ ...outputs[0], detail: " " }] })).toThrow();
  });
});

it("retains explicit semantic repair state and accepts legacy missing metadata", () => {
  const legacy = {
    kind: "repair-episode",
    recordId: "episode-codec",
    projectId: "project",
    taskId: "task",
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    failureFingerprint: "failure",
    relevantRevision: "tree",
    allowance: 2,
    semanticRepairs: 0,
    transportRetries: 0,
    timeoutCount: 0,
    attemptIds: [],
  };
  expect(decodeTeamRecord(legacy)).not.toHaveProperty("pendingSemanticRepair");
  for (const pendingSemanticRepair of [false, true])
    expect(decodeTeamRecord({ ...legacy, pendingSemanticRepair })).toHaveProperty(
      "pendingSemanticRepair",
      pendingSemanticRepair,
    );
  expect(() => decodeTeamRecord({ ...legacy, pendingSemanticRepair: "false" })).toThrow();
});

const decodeOpaqueTeamPage = Schema.decodeUnknownSync(ProjectTeamRecordPage);
const encodeOpaqueTeamPage = Schema.encodeSync(ProjectTeamRecordPage);

it("round-trips opaque foundation continuation cursors without changing their bytes", () => {
  for (const nextCursor of [" page-one ", "\tpage-two\n", " ", "x".repeat(4000)]) {
    const page = { projectId: "project", revision: 1, nextCursor, items: [] };
    expect(encodeOpaqueTeamPage(decodeOpaqueTeamPage(page))).toEqual(page);
  }
  for (const nextCursor of ["", "x".repeat(4001)]) {
    expect(() =>
      decodeOpaqueTeamPage({ projectId: "project", revision: 1, nextCursor, items: [] }),
    ).toThrow();
  }
});

it("accepts bounded project configuration without granting caller-created execution identity", () => {
  const roles = ["coordinator", "investigator", "planner", "implementer", "reviewer", "integrator"];
  const configure = {
    type: "project-team.configure",
    commandId: "configure",
    projectId: "project",
    expectedRevision: 0,
    expectedConfigurationGeneration: 0,
    enabled: true,
    providerInstanceId: "pi-instance",
    projectPriority: 3,
    taskPriorities: [{ taskId: "task", priority: 1 }],
    profiles: roles.map((role) => ({
      role,
      instructions: "Follow the approved assignment",
      skills: [],
      tools: ["read", "search"],
      model: "inclusionai/ling-3.1-flash:free",
      memoryAccess: "project",
      delegationDepth: 0,
    })),
    modelPolicies: [
      {
        model: "inclusionai/ling-3.1-flash:free",
        tokenLimit: 8192,
        durationLimitMs: 60000,
        modelCalls: 2,
      },
    ],
  };
  expect(decodeIntent(configure)).toEqual(configure);
  for (const mutation of [
    { bindingId: "caller-binding" },
    { actor: { kind: "human" } },
    { profiles: configure.profiles.slice(1) },
    { profiles: [...configure.profiles.slice(1), configure.profiles[1]] },
    { modelPolicies: [{ ...configure.modelPolicies[0], tokenLimit: 0 }] },
    { taskPriorities: [{ taskId: "task", priority: 1.5 }] },
    { paidFallback: true },
    { projectPriority: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedConfigurationGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { taskPriorities: [{ taskId: "task", priority: Number.MIN_SAFE_INTEGER - 1 }] },
  ])
    expect(() => decodeIntent({ ...configure, ...mutation })).toThrow();
});

const verificationProposal = {
  type: "project-team.verification.propose",
  commandId: "verification-command",
  projectId: "project",
  taskId: "task",
  expectedRevision: 3,
  expectedTaskRevision: 2,
  specRevision: 1,
  planRevision: 1,
  jobId: "verification-job",
  bindingId: "settled-implementation",
  expectedBindingRevision: 5,
  generation: 7,
  criterionIds: ["criterion"],
  command: {
    executable: "/opt/test runner",
    argv: ["", "  literal  ", "$(literal); *", "line\nbreak"],
    limits: { maxDurationMs: 120_000, maxOutputBytes: 65_536 },
    environment: "clean",
  },
};

it("accepts a human verification selection through the public write union without changing literal arguments", () => {
  expect(decodeIntent(verificationProposal)).toEqual(verificationProposal);
  expect(decodePublicWrite(verificationProposal)).toEqual(verificationProposal);
});

it("rejects caller host authority and invalid ownership selections on verification proposals", () => {
  for (const change of [
    { manifest: {} },
    { sha256: "a".repeat(64) },
    { verification: { jobId: "verification-job", sha256: "a".repeat(64) } },
    { target: { worktree: "/host" } },
    { workspaceReceiptHash: "b".repeat(64) },
    { criterionIds: [] },
    { criterionIds: ["criterion", "criterion"] },
    { criterionIds: Array.from({ length: 65 }, (_, i) => `criterion-${i}`) },
    { criterionIds: ["x".repeat(257)] },
    { jobId: " job " },
    { bindingId: "" },
    { projectId: "x".repeat(257) },
    { taskId: "x".repeat(257) },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { expectedBindingRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedTaskRevision: 1.5 },
    { specRevision: -1 },
    { planRevision: Number.MAX_SAFE_INTEGER + 1 },
    { command: { ...verificationProposal.command, env: { TOKEN: "secret" } } },
    { command: { ...verificationProposal.command, argv: ["bad\0arg"] } },
    {
      command: { ...verificationProposal.command, limits: { maxDurationMs: 0, maxOutputBytes: 1 } },
    },
  ]) {
    expect(() => decodeIntent({ ...verificationProposal, ...change })).toThrow();
    expect(() => decodePublicWrite({ ...verificationProposal, ...change })).toThrow();
  }
});

const verificationGate = {
  kind: "gate",
  recordId: "gate",
  projectId: "project",
  revision: 0,
  generation: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "pending",
  taskId: "task",
  gate: "verification",
  specRevision: 1,
  planRevision: 1,
  contentHash: "a".repeat(64),
  verificationJobId: "verification-job",
  evidenceIds: [],
  attribution: {
    actor: { kind: "human", id: "user" },
    source: { kind: "web" },
    recordedAt: "2026-01-01T00:00:00.000Z",
  },
};

it("retains a verification gate's exact job pointer and hash for human approval and future read states", () => {
  expect(decodeTeamRecord(verificationGate)).toEqual(verificationGate);
  expect(decodeTeamRecordRead({ ...verificationGate, status: "future-state" })).toEqual({
    ...verificationGate,
    status: "future-state",
  });
});

it("denies missing or malformed verification gate authority and pointers on every other known write gate", () => {
  for (const change of [
    { verificationJobId: undefined },
    { verificationJobId: "" },
    { verificationJobId: " job " },
    { verificationJobId: "x".repeat(257) },
    { contentHash: "hash" },
    { contentHash: "A".repeat(64) },
    { contentHash: "a".repeat(63) },
  ]) {
    expect(() => decodeTeamRecord({ ...verificationGate, ...change })).toThrow();
    const read = decodeTeamRecordRead({ ...verificationGate, ...change });
    expect(read).not.toHaveProperty("verificationJobId");
    expect(read).not.toHaveProperty("contentHash");
  }
  const { verificationJobId: _jobId, ...legacyGate } = verificationGate;
  for (const gate of [
    "investigation",
    "assignment",
    "specification",
    "plan",
    "execution",
    "merge",
    "repair",
  ]) {
    expect(() => decodeTeamRecord({ ...verificationGate, gate })).toThrow();
    expect(decodeTeamRecord({ ...legacyGate, gate, contentHash: "legacy-hash" })).toMatchObject({
      gate,
      contentHash: "legacy-hash",
    });
  }
});

it("preserves unknown gate kinds and statuses without accepting them as current write gates", () => {
  const future = {
    ...verificationGate,
    gate: "future-gate",
    status: "future-status",
    contentHash: "future-hash",
  };
  expect(decodeTeamRecordRead(future)).toEqual(future);
  expect(() => decodeTeamRecord(future)).toThrow();
});

describe("authenticated review finding wire contracts", () => {
  const provenance = {
    reviewTaskId: "review-child",
    bindingId: "review-binding",
    generation: 2,
    memberId: "review-member",
    providerInstanceId: "pi-review",
    threadId: "review-thread",
    sessionId: "review-session",
    initializeOperationId: "review-initialize",
    dispatchId: "review-dispatch",
    targetSha256: "a".repeat(64),
  };
  const finding = {
    kind: "review-finding",
    recordId: "finding-record",
    projectId: "project",
    taskId: "parent",
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    findingId: "finding-one",
    status: "open",
    severity: "high",
    criterionIds: ["criterion-one"],
    detail: "The original target omits the required retry boundary.",
    resolutionArtifactIds: [],
    target: {
      projectId: "project",
      taskId: "parent",
      specRevision: 3,
      planRevision: 4,
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    originReviewer: provenance,
    reportedBy: provenance,
  };
  const findingIntent = {
    type: "project-team.review.finding.record",
    commandId: "report-finding",
    projectId: "project",
    taskId: "review-child",
    expectedRevision: 8,
    expectedTaskRevision: 2,
    specRevision: 1,
    planRevision: 0,
    findingId: "finding-one",
    revision: 0,
    severity: "high",
    criterionIds: ["criterion-one"],
    detail: finding.detail,
    status: "open",
    resolutionArtifactIds: [],
  };
  it("accepts a child-scoped report and retains the distinct host-derived parent target", () => {
    expect(decodeIntent(findingIntent)).toEqual(findingIntent);
    expect(decodePublicWrite(findingIntent)).toEqual(findingIntent);
    expect(decodeTeamRecord(finding)).toEqual(finding);
  });
  it.each(["target", "originReviewer", "reportedBy", "bindingId", "sessionId", "freshness"])(
    "rejects caller-authored %s authority in a report",
    (field) => {
      expect(() => decodeIntent({ ...findingIntent, [field]: finding.target })).toThrow();
    },
  );
  it("bounds stable finding identity, revisions, criteria and retained report content", () => {
    for (const extra of [
      { findingId: " " },
      { findingId: "x".repeat(257) },
      { findingId: "finding\0one" },
      { revision: -1 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { criterionIds: [] },
      { criterionIds: ["criterion-one", "criterion-one"] },
      { criterionIds: Array.from({ length: 65 }, (_, i) => `criterion-${i}`) },
      { detail: " " },
      { detail: "x".repeat(32_001) },
      { severity: "unknown" },
      { resolutionArtifactIds: ["artifact", "artifact"] },
    ])
      expect(() => decodeIntent({ ...findingIntent, ...extra })).toThrow();
  });
  it("retains future read severity and status without accepting them in writes", () => {
    const future = { ...finding, severity: "blocking", status: "reopened" };
    expect(decodeTeamRecordRead(future)).toEqual(future);
    expect(() => decodeTeamRecord(future)).toThrow();
  });
  it("rejects mismatched parent ownership, malformed provenance and conflicting open resolution", () => {
    for (const value of [
      { ...finding, taskId: "foreign-parent" },
      { ...finding, target: { ...finding.target, projectId: "foreign-project" } },
      { ...finding, originReviewer: { ...provenance, targetSha256: "not-a-digest" } },
      { ...finding, reportedBy: { ...provenance, generation: -1 } },
      { ...finding, resolutionArtifactIds: ["unqualified-artifact"] },
    ])
      expect(() => decodeTeamRecord(value)).toThrow();
  });
});

it("accepts bounded source references while rejecting caller-frozen plan facts", () => {
  const ref = {
    taskId: "source",
    bindingId: "binding",
    expectedBindingRevision: 1,
    generation: 0,
    reviewDispatchId: "review",
    expectedReviewProposalSha256: "a".repeat(64),
    verificationJobId: "job",
    expectedManifestHash: "b".repeat(64),
    expectedBranchRef: "refs/heads/source",
    expectedBaseSha: "c".repeat(40),
    expectedHeadSha: "d".repeat(40),
    expectedTestedTree: "e".repeat(40),
  };
  const decode = Schema.decodeUnknownSync(ProjectTeamIntegrationSourceRefs);
  expect(decode([ref])).toEqual([ref]);
  expect(() => decode([])).toThrow();
  expect(() => decode([ref, ref])).toThrow();
  expect(() => decode([{ ...ref, expectedManifestHash: "missing" }])).toThrow();
  const proposal = {
    type: "project-team.plan.propose",
    commandId: "source-plan",
    projectId: "project",
    taskId: "integration",
    expectedRevision: 1,
    expectedTaskRevision: 1,
    specRevision: 1,
    content: "Combine selected reviewed commits",
    dependencyTaskIds: [],
    integrationSourceRefs: [ref],
  };
  expect(decodeGuided(proposal)).toEqual(proposal);
  expect(() =>
    decodeGuided({
      ...proposal,
      integrationSources: { version: 1, environmentId: "environment", sources: [] },
    }),
  ).toThrow();
});
