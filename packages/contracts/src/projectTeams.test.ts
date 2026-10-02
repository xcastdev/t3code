import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectTeamCredential,
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
