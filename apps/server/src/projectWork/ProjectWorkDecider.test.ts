import {
  ProjectId,
  CommandId,
  ProjectWorkAttemptId,
  ProjectWorkBlockerId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  ProjectWorkRelationshipId,
  ProjectWorkResultId,
  ProjectWorkApprovalId,
  ProjectWorkCommentId,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkEvidenceId,
  projectWorkPayloadFingerprint,
  type ProjectWorkAttribution,
  type ProjectWorkCriterion,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectWorkEvents,
  emptyProjectWorkReducerState,
  decideProjectWorkCommand,
  type ProjectWorkReducerState,
  type ProjectWorkState,
  projectWorkEventIdFor,
} from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

const projectId = ProjectId.make("project-1");
const attribution: ProjectWorkAttribution = {
  actor: { kind: "human", id: "human-1" },
  source: { kind: "web", id: "client-1" },
  recordedAt: "2026-01-01T00:00:00.000Z",
};

const task = (taskId: string, state: ProjectWorkTask["state"] = "draft"): ProjectWorkTask => ({
  taskId: ProjectWorkTaskId.make(taskId),
  projectId,
  title: taskId,
  state,
  watchers: [],
  revision: 0,
  specRevision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(state === "completed" ? { completedAt: "2026-01-01T00:00:00.000Z" } : {}),
});

const criterion = (
  taskId: string,
  criterionId: string,
  status: ProjectWorkCriterion["status"] = "unsatisfied",
): ProjectWorkCriterion => ({
  criterionId: ProjectWorkCriterionId.make(criterionId),
  taskId: ProjectWorkTaskId.make(taskId),
  description: criterionId,
  required: true,
  status,
  satisfiedByEvidenceIds: [],
  revision: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const emptyState = (tasks: ReadonlyArray<ProjectWorkTask> = []): ProjectWorkState => ({
  projectId,
  revision: 0,
  tasks: [...tasks],
  attempts: [],
  criteria: [],
  evidence: [],
  relationships: [],
  blockers: [],
  attention: [],
});

describe("ProjectWorkDecider human commands", () => {
  it("rejects a criterion upsert that smuggles in a waiver", () => {
    const state = emptyState([task("task-1")]);
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.criterion.upsert",
        commandId: CommandId.make("criterion-upsert-with-waiver"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        criterion: {
          ...criterion("task-1", "criterion-1"),
          waiver: {
            reason: "not needed",
            evidenceIds: [],
            specRevision: 0,
            waivedAt: "2026-01-01T00:00:00.000Z",
            attribution,
          },
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/cannot waive/i);
  });

  it("owns revisions and timestamps when an existing criterion is upserted", () => {
    const state = emptyState([task("task-1")]);
    state.criteria.push({ ...criterion("task-1", "criterion-1"), revision: 7 });

    for (const suppliedRevision of [1, 99]) {
      const updatedAt = `2026-01-01T00:00:${suppliedRevision === 1 ? "01" : "02"}.000Z`;
      const events = decideProjectWorkCommand(state, {
        type: "project-work.criterion.upsert",
        commandId: CommandId.make(`criterion-revision-${suppliedRevision}`),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        criterion: {
          ...criterion("task-1", "criterion-1"),
          description: `caller revision ${suppliedRevision}`,
          revision: suppliedRevision,
          updatedAt: "1999-01-01T00:00:00.000Z",
        },
        updatedAt,
      });
      const event = events[0];
      expect(event?.type).toBe("project-work.criterion.upserted");
      if (event?.type !== "project-work.criterion.upserted") throw new Error("wrong event");
      expect(event.criterion.revision).toBe(8);
      expect(event.criterion.updatedAt).toBe(updatedAt);
      expect(applyProjectWorkEvents(state, events).criteria[0]).toEqual(event.criterion);
    }

    const created = decideProjectWorkCommand(emptyState([task("task-1")]), {
      type: "project-work.criterion.upsert",
      commandId: CommandId.make("criterion-initial-revision"),
      projectId,
      taskId: ProjectWorkTaskId.make("task-1"),
      criterion: { ...criterion("task-1", "criterion-new"), revision: 4 },
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
    expect(
      created[0]?.type === "project-work.criterion.upserted"
        ? created[0].criterion.revision
        : undefined,
    ).toBe(4);
  });

  it("rejects specifying a task without every required criterion", () => {
    expect(() =>
      decideProjectWorkCommand(emptyState([task("task-1")]), {
        type: "project-work.task.specify",
        commandId: CommandId.make("command-1"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        specification: {
          objective: "Ship it",
          scopeIn: "The feature",
          scopeOut: "Everything else",
          criterionIds: [ProjectWorkCriterionId.make("missing")],
          revision: 1,
          protected: false,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/criteria/i);

    const foreignState = emptyState([task("task-1")]);
    foreignState.criteria.push(criterion("task-2", "foreign"));
    expect(() =>
      decideProjectWorkCommand(foreignState, {
        type: "project-work.task.specify",
        commandId: CommandId.make("command-foreign-criterion"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        specification: {
          objective: "Ship it",
          scopeIn: "The feature",
          scopeOut: "Everything else",
          criterionIds: [ProjectWorkCriterionId.make("foreign")],
          revision: 1,
          protected: false,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/criteria|task/i);

    const staleState = emptyState([task("task-1", "specified")]);
    staleState.criteria.push(criterion("task-1", "criterion-1"));
    Object.assign(staleState.tasks[0]!, {
      specification: {
        objective: "Original",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
        revision: 2,
        protected: false,
      },
      specRevision: 2,
    });
    expect(() =>
      decideProjectWorkCommand(staleState, {
        type: "project-work.task.specify",
        commandId: CommandId.make("command-stale-specification"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        specification: {
          objective: "Older",
          scopeIn: "The feature",
          scopeOut: "Everything else",
          criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
          revision: 1,
          protected: false,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/revision/i);
  });

  it("rejects ready when a dependency is unresolved, including a canceled dependency", () => {
    const state = emptyState([task("dependent"), task("dependency", "canceled")]);
    state.criteria.push(criterion("dependent", "criterion-1"));
    Object.assign(state.tasks[0]!, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
        revision: 1,
        protected: false,
      },
    });
    Object.assign(state.tasks[0]!, { state: "specified" });
    state.relationships.push({
      relationshipId: ProjectWorkRelationshipId.make("relationship-1"),
      projectId,
      fromTaskId: ProjectWorkTaskId.make("dependent"),
      toTaskId: ProjectWorkTaskId.make("dependency"),
      kind: "depends-on",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.task.ready",
        commandId: CommandId.make("command-2"),
        projectId,
        taskId: ProjectWorkTaskId.make("dependent"),
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/dependency/i);
  });

  it("rejects dependency cycles and reports the discovered path", () => {
    const state = emptyState([task("one"), task("two")]);
    state.relationships.push({
      relationshipId: ProjectWorkRelationshipId.make("relationship-1"),
      projectId,
      fromTaskId: ProjectWorkTaskId.make("one"),
      toTaskId: ProjectWorkTaskId.make("two"),
      kind: "depends-on",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.relationship.link",
        commandId: CommandId.make("command-3"),
        projectId,
        relationship: {
          relationshipId: ProjectWorkRelationshipId.make("relationship-2"),
          projectId,
          fromTaskId: ProjectWorkTaskId.make("two"),
          toTaskId: ProjectWorkTaskId.make("one"),
          kind: "depends-on",
          revision: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        linkedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/two.*one.*two/i);
  });

  it("rejects relationship and criterion writes that cross aggregate ownership", () => {
    const state = emptyState([task("one"), task("two")]);
    state.criteria.push(criterion("two", "criterion-1"));
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.relationship.link",
        commandId: CommandId.make("command-cross-project-relationship"),
        projectId,
        relationship: {
          relationshipId: ProjectWorkRelationshipId.make("relationship-cross-project"),
          projectId: ProjectId.make("project-2"),
          fromTaskId: ProjectWorkTaskId.make("one"),
          toTaskId: ProjectWorkTaskId.make("two"),
          kind: "relates-to",
          revision: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        linkedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/project/i);
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.criterion.upsert",
        commandId: CommandId.make("command-cross-task-criterion"),
        projectId,
        taskId: ProjectWorkTaskId.make("one"),
        criterion: criterion("one", "criterion-1"),
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/criterion|task/i);
  });

  it("duplicates as a draft and links the source without copying completion state", () => {
    const state = emptyState([task("source", "completed")]);
    const events = decideProjectWorkCommand(state, {
      type: "project-work.task.duplicate",
      commandId: CommandId.make("command-5"),
      projectId,
      sourceTaskId: ProjectWorkTaskId.make("source"),
      duplicateTaskId: ProjectWorkTaskId.make("copy"),
      title: "Copy",
      duplicatedAt: "2026-01-01T00:00:00.000Z",
    });
    const next = applyProjectWorkEvents(state, events);
    expect(next.tasks.find((entry) => entry.taskId === "copy")?.state).toBe("draft");
    expect(next.relationships.find((entry) => entry.fromTaskId === "copy")?.kind).toBe(
      "duplicates",
    );
  });

  it("protects a specification explicitly and rejects later mutation", () => {
    const source = task("task-1", "specified");
    Object.assign(source, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
        revision: 1,
        protected: false,
      },
    });
    const state = emptyState([source]);
    state.criteria.push(criterion("task-1", "criterion-1"));
    const protectedEvents = decideProjectWorkCommand(state, {
      type: "project-work.task.protect-specification",
      commandId: CommandId.make("command-6"),
      projectId,
      taskId: ProjectWorkTaskId.make("task-1"),
      specRevision: 1,
      protectedAt: "2026-01-01T00:00:00.000Z",
      attribution,
    });
    const protectedState = applyProjectWorkEvents(state, protectedEvents);
    expect(protectedState.tasks[0]!.specification?.protected).toBe(true);
    expect(() =>
      decideProjectWorkCommand(protectedState, {
        type: "project-work.task.specify",
        commandId: CommandId.make("command-7"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        specification: { ...source.specification!, objective: "Changed" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(ProjectWorkPolicyError);

    const directProtectedState = emptyState([task("draft")]);
    directProtectedState.criteria.push(criterion("draft", "criterion-1"));
    expect(() =>
      decideProjectWorkCommand(directProtectedState, {
        type: "project-work.task.specify",
        commandId: CommandId.make("command-direct-protected"),
        projectId,
        taskId: ProjectWorkTaskId.make("draft"),
        specification: {
          objective: "Ship it",
          scopeIn: "The feature",
          scopeOut: "Everything else",
          criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
          revision: 1,
          protected: true,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/approval|protect/i);
  });

  it("binds protected revisions to the complete payload and invalidates affected results", () => {
    const source = task("task-1", "specified");
    Object.assign(source, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
        revision: 1,
        protected: true,
      },
    });
    Object.assign(source, { specRevision: 1 });
    const state = emptyState([source]);
    state.criteria.push(criterion("task-1", "criterion-1", "satisfied"));
    const specification = {
      objective: source.specification?.objective ?? "Ship it",
      scopeIn: source.specification?.scopeIn ?? "The feature",
      scopeOut: source.specification?.scopeOut ?? "Everything else",
      criterionIds: source.specification?.criterionIds ?? [
        ProjectWorkCriterionId.make("criterion-1"),
      ],
      revision: 2,
      protected: true,
    };
    const approval = {
      approvalId: ProjectWorkApprovalId.make("approval-1"),
      taskId: source.taskId,
      specRevision: 2,
      approvedAt: "2026-01-01T00:00:00.000Z",
      attribution,
    };
    const criterionSnapshot = state.criteria[0]!;
    const payload = {
      type: "project-work.task.revise-protected-specification",
      commandId: "command-protected-revision",
      projectId,
      taskId: source.taskId,
      expectedRevision: undefined,
      specification,
      criterionSnapshots: [criterionSnapshot],
      affectedResultIds: [ProjectWorkResultId.make("result-1")],
      attribution,
      revisedAt: "2026-01-01T00:00:00.000Z",
      approval,
    };
    const events = decideProjectWorkCommand(state, {
      type: "project-work.task.revise-protected-specification",
      commandId: CommandId.make("command-protected-revision"),
      projectId,
      taskId: source.taskId,
      specification,
      criterionSnapshots: [criterionSnapshot],
      affectedResultIds: [ProjectWorkResultId.make("result-1")],
      approval: { ...approval, payloadFingerprint: projectWorkPayloadFingerprint(payload) },
      revisedAt: "2026-01-01T00:00:00.000Z",
      attribution,
    });
    const next = applyProjectWorkEvents(state, events);
    expect(next.resultInvalidations).toEqual([
      { resultId: "result-1", specRevision: 2, invalidatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(next.tasks[0]?.specRevision).toBe(2);
    expect(events[0]).toMatchObject({
      type: "project-work.task.specification-revised",
      resultInvalidations: [{ resultId: "result-1", specRevision: 2 }],
    });
    expect(next.history?.map((entry) => entry.type)).toEqual([
      "project-work.task.specification-revised",
    ]);
    expect(state.tasks[0]?.specRevision).toBe(1);
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.task.revise-protected-specification",
        commandId: CommandId.make("command-tampered"),
        projectId,
        taskId: source.taskId,
        specification: { ...specification, objective: "Tampered" },
        criterionSnapshots: [criterionSnapshot],
        affectedResultIds: [ProjectWorkResultId.make("result-1")],
        approval:
          events[0]!.type === "project-work.task.specification-revised"
            ? events[0]!.approval
            : undefined!,
        revisedAt: "2026-01-01T00:00:00.000Z",
        attribution,
      }),
    ).toThrow(/complete revision payload/i);

    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.task.revise-protected-specification",
        commandId: CommandId.make("command-tampered-criterion"),
        projectId,
        taskId: source.taskId,
        specification,
        criterionSnapshots: [{ ...criterionSnapshot, description: "Tampered" }],
        affectedResultIds: [ProjectWorkResultId.make("result-1")],
        approval:
          events[0]!.type === "project-work.task.specification-revised"
            ? events[0]!.approval
            : undefined!,
        revisedAt: "2026-01-01T00:00:00.000Z",
        attribution,
      }),
    ).toThrow(/complete revision payload|criterion snapshot/i);

    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.task.revise-protected-specification",
        commandId: CommandId.make("command-missing-attribution"),
        projectId,
        taskId: source.taskId,
        specification,
        criterionSnapshots: [criterionSnapshot],
        affectedResultIds: [ProjectWorkResultId.make("result-1")],
        approval:
          events[0]!.type === "project-work.task.specification-revised"
            ? events[0]!.approval
            : undefined!,
        revisedAt: "2026-01-01T00:00:00.000Z",
        attribution: undefined!,
      }),
    ).toThrow();
  });

  it("rejects ordinary criterion edits after specification protection", () => {
    const source = task("task-1", "specified");
    Object.assign(source, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
        revision: 1,
        protected: true,
      },
    });
    const state = emptyState([source]);
    state.criteria.push(criterion("task-1", "criterion-1"));
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.criterion.upsert",
        commandId: CommandId.make("command-protected-upsert"),
        projectId,
        taskId: source.taskId,
        criterion: criterion("task-1", "criterion-1"),
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/protect/i);
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.criterion.waive",
        commandId: CommandId.make("command-protected-waive"),
        projectId,
        taskId: source.taskId,
        criterionId: ProjectWorkCriterionId.make("criterion-1"),
        waiver: {
          reason: "Waived",
          evidenceIds: [],
          specRevision: 1,
          waivedAt: "2026-01-01T00:00:00.000Z",
          attribution,
        },
        waivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/protect/i);
  });

  it("derives the superseded decision link and requires direct-call attribution", () => {
    const state = emptyState([task("task-1")]) as ProjectWorkReducerState;
    state.decisions = [
      {
        decisionId: ProjectWorkDecisionId.make("decision-1"),
        projectId,
        title: "Original",
        body: "Original body",
        state: "accepted",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        attribution,
      },
    ];
    const replacement = {
      decisionId: ProjectWorkDecisionId.make("decision-2"),
      projectId,
      title: "Replacement",
      body: "Replacement body",
      state: "proposed" as const,
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const command = {
      type: "project-work.decision.supersede" as const,
      commandId: CommandId.make("command-supersede"),
      projectId,
      decisionId: ProjectWorkDecisionId.make("decision-1"),
      replacement,
      supersededAt: "2026-01-01T00:00:00.000Z",
      attribution,
    };
    const [event] = decideProjectWorkCommand(state, command);
    expect(event).toMatchObject({
      type: "project-work.decision.superseded",
      replacement: {
        supersedesDecisionId: "decision-1",
        attribution,
      },
    });

    expect(() => decideProjectWorkCommand(state, { ...command, attribution: undefined! })).toThrow(
      /attribution/i,
    );
    expect(() =>
      decideProjectWorkCommand(state, {
        ...command,
        replacement: { ...replacement, supersedesDecisionId: ProjectWorkDecisionId.make("other") },
      }),
    ).toThrow(/supersede/i);
    const [matchingEvent] = decideProjectWorkCommand(state, {
      ...command,
      replacement: { ...replacement, supersedesDecisionId: command.decisionId },
    });
    expect(matchingEvent).toMatchObject({
      replacement: { supersedesDecisionId: command.decisionId },
    });
    const replacementAttribution: ProjectWorkAttribution = {
      actor: { kind: "agent", id: "agent-1" },
      source: { kind: "mcp", id: "mcp-1" },
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    const [attributedEvent] = decideProjectWorkCommand(state, {
      ...command,
      replacement: { ...replacement, attribution: replacementAttribution },
    });
    expect(attributedEvent).toMatchObject({
      replacement: { attribution: replacementAttribution },
    });
  });
});

describe("human Work aggregate integrity", () => {
  it("rejects stale commands and cross-project events without mutating the aggregate", () => {
    const initial = emptyProjectWorkReducerState(projectId);
    const command = {
      type: "project-work.task.create" as const,
      commandId: CommandId.make("create"),
      projectId,
      taskId: ProjectWorkTaskId.make("first"),
      title: "First",
      expectedRevision: 0,
      createdAt: attribution.recordedAt,
      attribution,
    };
    const events = decideProjectWorkCommand(initial, command);
    const current = applyProjectWorkEvents(initial, events);
    expect(initial.tasks).toEqual([]);
    expect(current.revision).toBe(1);
    expect(() => decideProjectWorkCommand(current, command)).toThrow(/revision/i);
    expect(() =>
      decideProjectWorkCommand(initial, { ...command, projectId: ProjectId.make("foreign") }),
    ).toThrow(/project/i);
    expect(() =>
      applyProjectWorkEvents(
        current,
        events.map((event) => ({ ...event, projectId: "foreign" })),
      ),
    ).toThrow(/project/i);
    expect(current.tasks).toHaveLength(1);
  });

  it("retries produce stable event IDs and event replay is idempotent", () => {
    const state = emptyProjectWorkReducerState(projectId);
    const command = {
      type: "project-work.task.create" as const,
      commandId: CommandId.make("shared-command"),
      projectId,
      taskId: ProjectWorkTaskId.make("first"),
      title: "First",
      createdAt: attribution.recordedAt,
      attribution,
    };
    const events = decideProjectWorkCommand(state, command);
    expect(decideProjectWorkCommand(state, command)).toEqual(events);
    const once = applyProjectWorkEvents(state, events);
    expect(applyProjectWorkEvents(once, [...events, ...events])).toEqual(once);
    expect(
      decideProjectWorkCommand(
        { ...state, projectId: "other" },
        { ...command, projectId: ProjectId.make("other") },
      )[0]?.eventId,
    ).not.toBe(events[0]?.eventId);
  });

  it("captures inert guided drafts while refusing execution and assignment", () => {
    const state = emptyState([task("one")]);
    const common = { commandId: CommandId.make("unsupported"), projectId, attribution };
    expect(() =>
      decideProjectWorkCommand(state, {
        ...common,
        type: "project-work.task.assign",
        taskId: ProjectWorkTaskId.make("one"),
        assignee: null,
        assignedAt: attribution.recordedAt,
      }),
    ).toThrow(expect.objectContaining({ code: "deferred-command" }));
    expect(
      decideProjectWorkCommand(state, {
        ...common,
        type: "project-work.foundation.commit",
        expectedRevision: 0,
        records: [],
        committedAt: attribution.recordedAt,
      }),
    ).toEqual([]);
    const captured = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        ...common,
        type: "project-work.task.create",
        taskId: ProjectWorkTaskId.make("two"),
        title: "Managed",
        deliverableKind: "code",
        createdAt: attribution.recordedAt,
      }),
    );
    expect(captured.tasks.find((entry) => entry.taskId === "two")?.state).toBe("draft");
    expect(captured.attempts).toEqual([]);
    expect(() =>
      decideProjectWorkCommand(state, {
        ...common,
        type: "project-work.task.claim",
        taskId: ProjectWorkTaskId.make("one"),
        attemptId: ProjectWorkAttemptId.make("attempt"),
        leaseToken: "token",
        leasedUntil: attribution.recordedAt,
        claimedAt: attribution.recordedAt,
      }),
    ).toThrow(expect.objectContaining({ code: "deferred-command" }));
    expect(state.attempts).toEqual([]);
  });

  it("checks blocks direction correctly and lets unlink remove the dependency", () => {
    const state = emptyState([task("one"), task("two")]);
    const link = (id: string, from: string, to: string, kind: "blocks" | "depends-on") => ({
      type: "project-work.relationship.link" as const,
      commandId: CommandId.make(id),
      projectId,
      linkedAt: attribution.recordedAt,
      relationship: {
        relationshipId: ProjectWorkRelationshipId.make(id),
        projectId,
        fromTaskId: ProjectWorkTaskId.make(from),
        toTaskId: ProjectWorkTaskId.make(to),
        kind,
        revision: 0,
        createdAt: attribution.recordedAt,
      },
    });
    const next = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, link("a", "one", "two", "depends-on")),
    );
    // The equivalent blocks edge adds no cycle.
    expect(decideProjectWorkCommand(next, link("b", "two", "one", "blocks"))).toHaveLength(1);
    expect(() => decideProjectWorkCommand(next, link("c", "one", "two", "blocks"))).toThrow(
      /cycle/i,
    );
    const unlinked = applyProjectWorkEvents(
      next,
      decideProjectWorkCommand(next, {
        type: "project-work.relationship.unlink",
        commandId: CommandId.make("unlink"),
        projectId,
        relationshipId: ProjectWorkRelationshipId.make("a"),
        unlinkedAt: attribution.recordedAt,
      }),
    );
    expect(unlinked.relationships).toEqual([]);
    expect(decideProjectWorkCommand(unlinked, link("c", "one", "two", "blocks"))).toHaveLength(1);
  });

  it("blocks and resolves a task while preserving question and resolver records", () => {
    const state = emptyState([task("one")]);
    const blocked = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        type: "project-work.task.block",
        commandId: CommandId.make("block"),
        projectId,
        taskId: ProjectWorkTaskId.make("one"),
        blockerId: ProjectWorkBlockerId.make("question"),
        reason: "Which database?",
        resolver: "human-1",
        referenceIds: ["design-question"],
        blockedAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(blocked.attention[0]).toMatchObject({ reason: "blocked" });
    const resolved = applyProjectWorkEvents(
      blocked,
      decideProjectWorkCommand(blocked, {
        type: "project-work.task.resolve-blocker",
        commandId: CommandId.make("answer"),
        projectId,
        taskId: ProjectWorkTaskId.make("one"),
        blockerId: ProjectWorkBlockerId.make("question"),
        resolvedAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(resolved.tasks[0]?.blockerId).toBeUndefined();
    expect(resolved.blockers[0]).toMatchObject({
      reason: "Which database?",
      referenceIds: ["design-question"],
      resolvedAt: attribution.recordedAt,
      attention: false,
    });
    expect(resolved.attention[0]?.resolvedAt).toBe(attribution.recordedAt);
    expect(blocked.blockers[0]?.resolvedAt).toBeUndefined();
  });

  it("reverses watches and preserves authenticated agent provenance in activities", () => {
    const state = emptyState([task("one")]);
    const origin: ProjectWorkAttribution = {
      actor: { kind: "agent", id: "agent-1" },
      source: { kind: "mcp", id: "session-1" },
      recordedAt: attribution.recordedAt,
    };
    const watched = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        type: "project-work.task.watch",
        commandId: CommandId.make("watch"),
        projectId,
        taskId: ProjectWorkTaskId.make("one"),
        watcher: origin.actor,
        watchedAt: origin.recordedAt,
        attribution: origin,
      }),
    );
    const unwatched = applyProjectWorkEvents(
      watched,
      decideProjectWorkCommand(watched, {
        type: "project-work.task.unwatch",
        commandId: CommandId.make("unwatch"),
        projectId,
        taskId: ProjectWorkTaskId.make("one"),
        watcher: origin.actor,
        unwatchedAt: origin.recordedAt,
        attribution: origin,
      }),
    );
    expect(unwatched.tasks[0]?.watchers).toEqual([]);
    expect(unwatched.activities?.map((activity) => activity.attribution)).toEqual([origin, origin]);
    expect(unwatched.activities?.map((activity) => activity.occurredAt)).toEqual([
      origin.recordedAt,
      origin.recordedAt,
    ]);
  });
});

describe("human Work durable records", () => {
  it("records evidence and question comments without rewriting prior records", () => {
    const initial = emptyState([task("one")]);
    const evidence = {
      evidenceId: ProjectWorkEvidenceId.make("observation"),
      taskId: ProjectWorkTaskId.make("one"),
      kind: "observation" as const,
      summary: "The existing service uses SQLite",
      revision: 0,
      recordedAt: attribution.recordedAt,
      attribution,
    };
    const command = {
      type: "project-work.evidence.add" as const,
      commandId: CommandId.make("evidence"),
      projectId,
      evidence,
      addedAt: attribution.recordedAt,
      attribution,
    };
    const observed = applyProjectWorkEvents(initial, decideProjectWorkCommand(initial, command));
    expect(() =>
      decideProjectWorkCommand(observed, {
        ...command,
        commandId: CommandId.make("duplicate-evidence"),
      }),
    ).toThrow(/already exists/i);
    const comment = {
      commentId: ProjectWorkCommentId.make("question"),
      projectId,
      taskId: ProjectWorkTaskId.make("one"),
      body: "Should the new table reuse that service?",
      createdAt: attribution.recordedAt,
      revision: 0,
    };
    const commented = applyProjectWorkEvents(
      observed,
      decideProjectWorkCommand(observed, {
        type: "project-work.comment.add",
        commandId: CommandId.make("question"),
        projectId,
        comment,
        addedAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(commented.comments).toEqual([{ ...comment, attribution }]);
    expect(commented.evidence).toEqual([evidence]);
    expect(initial.evidence).toEqual([]);
    expect(commented.activities?.at(-1)?.attribution).toEqual(attribution);
    expect(() =>
      decideProjectWorkCommand(commented, {
        type: "project-work.comment.add",
        commandId: CommandId.make("foreign-comment"),
        projectId,
        comment: {
          ...comment,
          commentId: ProjectWorkCommentId.make("other"),
          projectId: ProjectId.make("foreign"),
        },
        addedAt: attribution.recordedAt,
        attribution,
      }),
    ).toThrow(/project/i);
  });

  it("proposes, accepts, rejects and supersedes decisions with transition provenance", () => {
    const initial = emptyProjectWorkReducerState(projectId);
    const decision = {
      decisionId: ProjectWorkDecisionId.make("proposal"),
      projectId,
      title: "Database",
      body: "Use SQLite",
      state: "proposed" as const,
      revision: 0,
      createdAt: attribution.recordedAt,
      updatedAt: attribution.recordedAt,
    };
    const proposed = applyProjectWorkEvents(
      initial,
      decideProjectWorkCommand(initial, {
        type: "project-work.decision.propose",
        commandId: CommandId.make("propose"),
        projectId,
        decision,
        proposedAt: attribution.recordedAt,
        attribution,
      }),
    );
    const rejected = applyProjectWorkEvents(
      proposed,
      decideProjectWorkCommand(proposed, {
        type: "project-work.decision.reject",
        commandId: CommandId.make("reject"),
        projectId,
        decisionId: decision.decisionId,
        reason: "Need a separate schema",
        rejectedAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(rejected.decisions?.[0]).toMatchObject({
      body: "Use SQLite",
      state: "rejected",
      rejectionReason: "Need a separate schema",
      revision: 1,
      stateTransitionAttribution: attribution,
    });
    const accepted = applyProjectWorkEvents(
      proposed,
      decideProjectWorkCommand(proposed, {
        type: "project-work.decision.accept",
        commandId: CommandId.make("accept"),
        projectId,
        decisionId: decision.decisionId,
        acceptedAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(() =>
      decideProjectWorkCommand(accepted, {
        type: "project-work.decision.reject",
        commandId: CommandId.make("reject-accepted"),
        projectId,
        decisionId: decision.decisionId,
        reason: "Changed mind",
        rejectedAt: attribution.recordedAt,
        attribution,
      }),
    ).toThrow(/proposed/i);
    const superseded = applyProjectWorkEvents(
      accepted,
      decideProjectWorkCommand(accepted, {
        type: "project-work.decision.supersede",
        commandId: CommandId.make("supersede"),
        projectId,
        decisionId: decision.decisionId,
        replacement: {
          ...decision,
          decisionId: ProjectWorkDecisionId.make("replacement"),
          body: "Use a separate SQLite schema",
        },
        supersededAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(superseded.decisions).toMatchObject([
      { state: "superseded", body: "Use SQLite" },
      { state: "proposed", supersedesDecisionId: decision.decisionId, attribution },
    ]);
    expect(proposed.decisions?.[0]?.state).toBe("proposed");
  });

  it("reopens completed work through readiness and preserves promoted knowledge history", () => {
    const initial = emptyState([task("one", "completed")]);
    const reopened = applyProjectWorkEvents(
      initial,
      decideProjectWorkCommand(initial, {
        type: "project-work.task.reopen",
        commandId: CommandId.make("reopen"),
        projectId,
        taskId: ProjectWorkTaskId.make("one"),
        reopenedAt: attribution.recordedAt,
        attribution,
      }),
    );
    expect(reopened.tasks[0]).toMatchObject({ state: "specified", revision: 1 });
    expect(reopened.tasks[0]?.completedAt).toBeUndefined();
    expect(initial.tasks[0]?.completedAt).toBeDefined();
    const knowledge = {
      knowledgeId: ProjectWorkKnowledgeId.make("finding"),
      projectId,
      title: "Database finding",
      body: "The service already uses SQLite",
      sourceKind: "task" as const,
      sourceId: "one",
      revision: 0,
      createdAt: attribution.recordedAt,
      updatedAt: attribution.recordedAt,
    };
    const command = {
      type: "project-work.knowledge.promote" as const,
      commandId: CommandId.make("promote"),
      projectId,
      knowledge,
      promotedAt: attribution.recordedAt,
      attribution,
    };
    const promoted = applyProjectWorkEvents(reopened, decideProjectWorkCommand(reopened, command));
    expect(promoted.knowledge).toEqual([{ ...knowledge, attribution }]);
    expect(() =>
      decideProjectWorkCommand(promoted, {
        ...command,
        commandId: CommandId.make("duplicate-promotion"),
      }),
    ).toThrow(/already exists/i);
    expect(() =>
      decideProjectWorkCommand(promoted, {
        ...command,
        knowledge: { ...knowledge, projectId: ProjectId.make("foreign") },
      }),
    ).toThrow(/project/i);
  });
});

it("namespaces every event kind by project even when command IDs are reused", () => {
  const make = (project: string) => {
    const state = { ...emptyState([task("one")]), projectId: project };
    return decideProjectWorkCommand(state, {
      type: "project-work.task.watch",
      commandId: CommandId.make("reused-command"),
      projectId: ProjectId.make(project),
      taskId: ProjectWorkTaskId.make("one"),
      watcher: attribution.actor,
      watchedAt: attribution.recordedAt,
    });
  };
  expect(make("first")[0]?.eventId).toBe(projectWorkEventIdFor("first", "reused-command", 0));
  expect(make("first")).toEqual(make("first"));
  expect(make("first")[0]?.eventId).not.toBe(make("second")[0]?.eventId);
  expect(projectWorkEventIdFor("a:b", "c", 0)).not.toBe(projectWorkEventIdFor("a", "b:c", 0));
  expect(projectWorkEventIdFor("first", "reused-command", 0)).not.toBe(
    projectWorkEventIdFor("first", "reused-command", 1),
  );
});

it("cannot resurrect canceled work by resolving its former blocker", () => {
  const initial = emptyState([task("one")]);
  const blocked = applyProjectWorkEvents(
    initial,
    decideProjectWorkCommand(initial, {
      type: "project-work.task.block",
      commandId: CommandId.make("block"),
      projectId,
      taskId: ProjectWorkTaskId.make("one"),
      blockerId: ProjectWorkBlockerId.make("blocker"),
      reason: "Question",
      resolver: "human",
      referenceIds: [],
      blockedAt: attribution.recordedAt,
    }),
  );
  const canceled = applyProjectWorkEvents(
    blocked,
    decideProjectWorkCommand(blocked, {
      type: "project-work.task.cancel",
      commandId: CommandId.make("cancel"),
      projectId,
      taskId: ProjectWorkTaskId.make("one"),
      canceledAt: attribution.recordedAt,
    }),
  );
  expect(() =>
    decideProjectWorkCommand(canceled, {
      type: "project-work.task.resolve-blocker",
      commandId: CommandId.make("resolve"),
      projectId,
      taskId: ProjectWorkTaskId.make("one"),
      blockerId: ProjectWorkBlockerId.make("blocker"),
      resolvedAt: attribution.recordedAt,
    }),
  ).toThrow(expect.objectContaining({ code: "invalid-state" }));
  expect(canceled.tasks[0]?.state).toBe("canceled");
});

it("refines an issue into an inert draft and preserves namespaced replay identities", () => {
  const initial = emptyProjectWorkReducerState(projectId);
  const issue = {
    kind: "issue" as const,
    recordId: "issue-source",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: attribution.recordedAt,
    observedAt: attribution.recordedAt,
    status: "open" as const,
    identity: { host: "github.com", repositoryNodeId: "repo", issueNodeId: "node", number: 1 },
    repositoryName: "owner/repo",
    title: "Observed issue",
    body: "Bounded work",
    sourceRevision: "source-1",
  };
  const synced = applyProjectWorkEvents(
    initial,
    decideProjectWorkCommand(initial, {
      type: "project-work.foundation.commit",
      commandId: CommandId.make("sync"),
      expectedRevision: initial.revision,
      projectId,
      records: [issue],
      committedAt: attribution.recordedAt,
      attribution: {
        ...attribution,
        actor: { kind: "system", id: "project-issue-sync" },
        source: { kind: "system", id: "github-issue-intake" },
      },
    }),
  );
  const command = {
    type: "project-work.issue.refine" as const,
    commandId: CommandId.make("refine"),
    projectId,
    expectedRevision: synced.revision,
    issueRecordId: issue.recordId,
    expectedIssueRevision: 0,
    target: {
      kind: "new-task" as const,
      taskId: ProjectWorkTaskId.make("refined-task"),
      title: "Refined",
      deliverableKind: "code" as const,
    },
    refinedAt: attribution.recordedAt,
    attribution,
  };
  const events = decideProjectWorkCommand(synced, command);
  const refined = applyProjectWorkEvents(synced, events);
  expect(refined.tasks[0]?.state).toBe("draft");
  expect(refined.attempts).toEqual([]);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  expect(applyProjectWorkEvents(refined, events)).toEqual(refined);
  expect(() => decideProjectWorkCommand(synced, { ...command, expectedIssueRevision: 1 })).toThrow(
    /stale/,
  );
  expect(() =>
    decideProjectWorkCommand(refined, {
      ...command,
      expectedRevision: refined.revision,
      expectedIssueRevision: 1,
    }),
  ).toThrow(/linked/);
  const linked = refined.foundationRecords!.find((r) => r.kind === "issue");
  if (linked?.kind !== "issue") throw new Error("Missing issue");
  expect(() =>
    decideProjectWorkCommand(refined, {
      type: "project-work.foundation.commit",
      commandId: CommandId.make("unlink-sync"),
      expectedRevision: refined.revision,
      projectId,
      records: [{ ...issue, revision: linked.revision + 1 }],
      committedAt: attribution.recordedAt,
      attribution: {
        ...attribution,
        actor: { kind: "system", id: "project-issue-sync" },
        source: { kind: "system", id: "github-issue-intake" },
      },
    }),
  ).toThrow(/work links/);
});

const ordinaryWaivedTask = () => {
  const source: ProjectWorkTask = {
    ...task("waived-task", "ready"),
    specRevision: 1,
    specification: {
      objective: "Bounded work",
      scopeIn: "One behavior",
      scopeOut: "Other work",
      criterionIds: [ProjectWorkCriterionId.make("waived-criterion")],
      revision: 1,
      protected: false,
    },
    approval: {
      approvalId: ProjectWorkApprovalId.make("old-approval"),
      taskId: ProjectWorkTaskId.make("waived-task"),
      specRevision: 1,
      approvedAt: attribution.recordedAt,
      attribution,
    },
  };
  const state = { ...emptyProjectWorkReducerState(projectId), tasks: [source] };
  state.criteria.push({
    ...criterion("waived-task", "waived-criterion", "waived"),
    waiver: {
      reason: "Original exception",
      evidenceIds: [],
      specRevision: 1,
      waivedAt: attribution.recordedAt,
      attribution,
    },
  });
  const command = {
    type: "project-work.criterion.revoke-waiver" as const,
    commandId: CommandId.make("revoke-waiver"),
    projectId,
    expectedRevision: state.revision,
    taskId: source.taskId,
    expectedTaskRevision: source.revision,
    criterionId: state.criteria[0]!.criterionId,
    expectedCriterionRevision: state.criteria[0]!.revision,
    expectedSpecRevision: 1,
    reason: "Exception no longer applies",
    attribution,
    revokedAt: attribution.recordedAt,
  };
  return { state, command };
};

it("explicitly revokes ordinary waiver authority, invalidates approval/readiness and retains replay history", () => {
  const { state, command } = ordinaryWaivedTask();
  const events = decideProjectWorkCommand(state, command);
  const next = applyProjectWorkEvents(state, events);
  expect(next.criteria[0]).toMatchObject({
    status: "unsatisfied",
    satisfiedByEvidenceIds: [],
    revision: 1,
  });
  expect(next.criteria[0]!.waiver).toBeUndefined();
  expect(next.tasks[0]).toMatchObject({ state: "specified", revision: 1 });
  expect(next.tasks[0]!.approval).toBeUndefined();
  expect(events[0]).toMatchObject({
    type: "project-work.criterion.waiver-revoked",
    reason: command.reason,
    attribution,
    previousWaiver: state.criteria[0]!.waiver,
  });
  expect(next.history?.[0]?.type).toBe("project-work.criterion.waiver-revoked");
  expect(next.activities?.[0]?.summary).toBe(command.reason);
  expect(applyProjectWorkEvents(next, events)).toEqual(next);
  expect(decideProjectWorkCommand(state, command)).toEqual(events);
  expect(() => decideProjectWorkCommand(next, command)).toThrow(/revision/);
  expect(state.criteria[0]!.status).toBe("waived");
  const rewaived = applyProjectWorkEvents(
    next,
    decideProjectWorkCommand(next, {
      type: "project-work.criterion.waive",
      commandId: CommandId.make("rewaive"),
      projectId,
      expectedRevision: next.revision,
      taskId: command.taskId,
      criterionId: command.criterionId,
      waiver: { ...state.criteria[0]!.waiver!, reason: "Fresh explicit exception" },
      waivedAt: attribution.recordedAt,
      attribution,
    }),
  );
  expect(rewaived.criteria[0]!.waiver?.reason).toBe("Fresh explicit exception");
  expect(rewaived.tasks[0]!.approval).toBeUndefined();
});

it("rejects stale, foreign, nonwaived, protected and nonhuman ordinary waiver revocations", () => {
  const { state, command } = ordinaryWaivedTask();
  for (const field of [
    "expectedRevision",
    "expectedTaskRevision",
    "expectedCriterionRevision",
    "expectedSpecRevision",
  ] as const)
    expect(() =>
      decideProjectWorkCommand(state, { ...command, [field]: command[field] + 1 }),
    ).toThrow(/revision/);
  expect(() =>
    decideProjectWorkCommand(state, { ...command, projectId: ProjectId.make("other") }),
  ).toThrow(/project/);
  expect(() => decideProjectWorkCommand(state, { ...command, reason: " " })).toThrow(/reason/);
  expect(() =>
    decideProjectWorkCommand(state, {
      ...command,
      attribution: { ...attribution, actor: { kind: "agent", id: "agent" } },
    }),
  ).toThrow(/human/);
  expect(() =>
    decideProjectWorkCommand(
      {
        ...state,
        criteria: state.criteria.map((entry) => ({
          ...entry,
          taskId: ProjectWorkTaskId.make("other-task"),
        })),
      },
      command,
    ),
  ).toThrow();
  const { waiver: _waiver, ...withoutWaiver } = state.criteria[0]!;
  expect(() =>
    decideProjectWorkCommand(
      { ...state, criteria: [{ ...withoutWaiver, status: "unsatisfied" }] },
      command,
    ),
  ).toThrow(/current ordinary waived/);
  expect(() =>
    decideProjectWorkCommand(
      {
        ...state,
        tasks: state.tasks.map((entry) => ({
          ...entry,
          specification: { ...entry.specification!, protected: true },
        })),
      },
      command,
    ),
  ).toThrow(/approved protected specification revision/);
  expect(() =>
    decideProjectWorkCommand(
      {
        ...state,
        criteria: state.criteria.map((entry) => ({
          ...entry,
          waiver: { ...entry.waiver!, specRevision: 0 },
        })),
      },
      command,
    ),
  ).toThrow(/current ordinary waived/);
  expect(() =>
    decideProjectWorkCommand(
      {
        ...state,
        foundationRecords: [
          {
            kind: "task-membership",
            recordId: "guided",
            projectId,
            taskId: command.taskId,
            revision: 0,
            generation: 0,
            updatedAt: attribution.recordedAt,
            status: "active",
            executionKind: "managed",
            deliverableKind: "code",
          },
        ],
      },
      command,
    ),
  ).toThrow(/ordinary/);
});

it("refuses ordinary waiver revocation on terminal work or an active attempt", () => {
  const { state, command } = ordinaryWaivedTask();
  for (const stateName of ["completed", "canceled"] as const)
    expect(() =>
      decideProjectWorkCommand(
        { ...state, tasks: state.tasks.map((task) => ({ ...task, state: stateName })) },
        command,
      ),
    ).toThrow(/nonterminal/);
  const running = {
    ...state,
    attempts: [
      {
        attemptId: ProjectWorkAttemptId.make("active"),
        taskId: command.taskId,
        state: "running" as const,
        checkpointIds: [],
        revision: 0,
      },
    ],
  };
  expect(() => decideProjectWorkCommand(running, command)).toThrow(/inactive/);
});

it("requires explicit human revocation before an upsert can clear or edit an existing waiver", () => {
  const { state, command } = ordinaryWaivedTask();
  const { waiver: _waiver, ...retained } = state.criteria[0]!;
  const edit = {
    type: "project-work.criterion.upsert" as const,
    commandId: CommandId.make("edit-waived"),
    projectId,
    taskId: command.taskId,
    criterion: { ...retained, description: "Edited requirement", status: "unsatisfied" as const },
    updatedAt: attribution.recordedAt,
    attribution: { ...attribution, actor: { kind: "agent" as const, id: "agent" } },
  };
  expect(() => decideProjectWorkCommand(state, edit)).toThrow(
    /Revoke the current waiver explicitly/,
  );
  expect(state.criteria[0]!.waiver?.reason).toBe("Original exception");
  expect(state.tasks[0]!.approval?.approvalId).toBe("old-approval");
  const revoked = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
  const edited = applyProjectWorkEvents(revoked, decideProjectWorkCommand(revoked, edit));
  expect(edited.criteria[0]).toMatchObject({
    description: "Edited requirement",
    status: "unsatisfied",
    revision: 2,
  });
  expect(edited.criteria[0]!.waiver).toBeUndefined();
  expect(edited.tasks[0]!.approval).toBeUndefined();
});
