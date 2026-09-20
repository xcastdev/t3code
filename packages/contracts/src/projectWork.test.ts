import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  ProjectWorkExport,
  ProjectWorkMarkdownExport,
  ProjectWorkCriterionRead,
  ProjectWorkReadRecord,
  ProjectWorkReadIntent,
  ProjectWorkBoundedReadEnvelope,
  ProjectWorkTask,
  ProjectWorkTaskRead,
  ProjectWorkTaskCreateCommand,
  ProjectWorkTaskSpecifyCommand,
  ProjectWorkTaskReviseProtectedSpecificationCommand,
  ProjectWorkDecisionSupersedeCommand,
  ProjectWorkTaskState,
  canonicalProjectWorkPayload,
  projectWorkPayloadFingerprint,
} from "./index.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeTaskCreate = Schema.decodeUnknownSync(ProjectWorkTaskCreateCommand);
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
