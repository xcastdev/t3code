import {
  ProjectId,
  EventId,
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
  ProjectWorkEvidenceId,
  projectWorkPayloadFingerprint,
  type ProjectIssueIntake,
  type ProjectTeamRecord,
  type ProjectWorkIssueRefineCommand,
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
  type ProjectWorkEvent,
  type ProjectWorkState,
} from "./ProjectWorkDecider.ts";
import { deriveProjectWorkTaskPolicy, ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";

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

describe("ProjectWorkDecider", () => {
  it("namespaces deterministic task-setup event IDs by project, command and index without delimiter collisions", () => {
    const create = (owner: string, commandId: string) =>
      decideProjectWorkCommand(
        { ...emptyState(), projectId: owner },
        {
          type: "project-work.task.create",
          commandId: CommandId.make(commandId),
          projectId: ProjectId.make(owner),
          taskId: ProjectWorkTaskId.make("namespace-task"),
          title: "Bounded work",
          deliverableKind: "research",
          createdAt: attribution.recordedAt,
          attribution,
        },
      );
    const first = create("namespace-project", "shared-command");
    expect(create("namespace-project", "shared-command")).toEqual(first);
    expect(first.map((event) => event.type)).toEqual([
      "project-work.task.created",
      "project-work.foundation.recorded",
    ]);
    const ids = [
      first[0]?.eventId,
      first[1]?.eventId,
      create("other-project", "shared-command")[0]?.eventId,
      create("namespace-project", "other-command")[0]?.eventId,
      create("namespace:project", "command")[0]?.eventId,
      create("namespace", "project:command")[0]?.eventId,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^project-work-event:v2:[a-f0-9]{64}$/);
      expect(id).not.toContain(":project-work:");
    }
  });

  it("preserves evidence and multi-event foundation identities used by retained authority readers", () => {
    const state = emptyState([task("task-1")]);
    const evidence = decideProjectWorkCommand(state, {
      type: "project-work.evidence.add",
      commandId: CommandId.make("retained-evidence"),
      projectId,
      addedAt: attribution.recordedAt,
      attribution,
      evidence: {
        evidenceId: ProjectWorkEvidenceId.make("retained-evidence-record"),
        taskId: ProjectWorkTaskId.make("task-1"),
        kind: "observation",
        summary: "Recorded human permission",
        revision: 0,
        recordedAt: attribution.recordedAt,
        attribution,
      },
    });
    expect(evidence.map((event) => event.eventId)).toEqual(["retained-evidence:project-work:0"]);
    expect(applyProjectWorkEvents(state, evidence).evidence).toMatchObject([
      { evidenceId: "retained-evidence-record", summary: "Recorded human permission" },
    ]);
    const foundation = decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      commandId: CommandId.make("retained-foundation"),
      projectId,
      expectedRevision: state.revision,
      committedAt: attribution.recordedAt,
      attribution,
      records: ["first-mission", "second-mission"].map((recordId) => ({
        kind: "mission" as const,
        recordId,
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: attribution.recordedAt,
        status: "draft" as const,
        title: recordId,
        objective: "Preserve retained authority identity",
        requiredTaskIds: [],
      })),
    });
    expect(foundation.map((event) => event.eventId)).toEqual([
      "retained-foundation:project-work:0",
      "retained-foundation:project-work:1",
    ]);
    expect(applyProjectWorkEvents(state, foundation).foundationRecords).toMatchObject([
      { kind: "mission", recordId: "first-mission" },
      { kind: "mission", recordId: "second-mission" },
    ]);
  });

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

  it("derives claimability and action availability from state rather than client hints", () => {
    const readyTask = task("ready", "ready");
    Object.assign(readyTask, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("ready-criterion")],
        revision: 1,
        protected: false,
      },
    });
    Object.assign(readyTask, { specRevision: 1 });
    const readyState = emptyState([readyTask]);
    readyState.criteria.push(criterion("ready", "ready-criterion", "satisfied"));
    const policy = deriveProjectWorkTaskPolicy(readyState, readyTask.taskId);
    expect(policy.claimability).toEqual({ claimable: true });
    expect(policy.actions.claim).toEqual({ available: true });
    expect(policy.actions["protect-specification"]).toEqual({ available: true });
    expect(policy.actions.assign).toEqual({ available: true });
    expect(policy.actions.watch).toEqual({ available: true });
    expect(policy.actions.fail).toEqual({ available: false, reason: "task-not-running" });
  });

  it("reports failure, resolution, reclaim, takeover, protected revision, and completion truthfully", () => {
    const running = task("policy-running", "in-progress");
    Object.assign(running, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("policy-criterion")],
        revision: 1,
        protected: true,
      },
      specRevision: 1,
      activeAttemptId: ProjectWorkAttemptId.make("policy-attempt"),
    });
    const runningState = emptyState([running]);
    runningState.criteria.push(criterion("policy-running", "policy-criterion", "satisfied"));
    runningState.attempts.push({
      attemptId: ProjectWorkAttemptId.make("policy-attempt"),
      taskId: running.taskId,
      state: "running",
      leasedUntil: "2027-01-01T00:00:00.000Z",
      checkpointIds: [],
      revision: 1,
    });
    const runningPolicy = deriveProjectWorkTaskPolicy(
      runningState,
      running.taskId,
      "2026-01-01T00:00:00.000Z",
    );
    expect(runningPolicy.actions.complete).toEqual({ available: true });
    expect(runningPolicy.actions.fail).toEqual({ available: true });
    expect(runningPolicy.actions.takeover).toEqual({ available: true });
    expect(runningPolicy.actions["revise-protected-specification"]).toEqual({ available: true });

    const failed = task("policy-failed", "failed");
    Object.assign(failed, {
      failureKind: "recoverable",
      specification: { ...running.specification!, protected: false },
      specRevision: 1,
    });
    const failedState = emptyState([failed]);
    failedState.criteria.push(criterion("policy-failed", "policy-criterion", "satisfied"));
    failedState.attempts.push({
      attemptId: ProjectWorkAttemptId.make("failed-attempt"),
      taskId: failed.taskId,
      state: "failed",
      failureKind: "recoverable",
      checkpointIds: [],
      revision: 1,
    });
    const failedPolicy = deriveProjectWorkTaskPolicy(failedState, failed.taskId);
    expect(failedPolicy.actions["resolve-failure"]).toEqual({ available: true });
    expect(failedPolicy.actions.reclaim).toEqual({ available: true });
  });

  it("keeps unprotected specified tasks refinable and lease-expired tasks reclaimable", () => {
    const specifiedTask = task("specified", "specified");
    Object.assign(specifiedTask, {
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("specified-criterion")],
        revision: 1,
        protected: false,
      },
      specRevision: 1,
    });
    const specifiedState = emptyState([specifiedTask]);
    specifiedState.criteria.push(criterion("specified", "specified-criterion", "satisfied"));
    expect(
      deriveProjectWorkTaskPolicy(specifiedState, specifiedTask.taskId).actions.specify,
    ).toEqual({ available: true });

    const expiredTask = task("expired", "failed");
    Object.assign(expiredTask, {
      failureKind: "lease-expired",
      specification: {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [ProjectWorkCriterionId.make("expired-criterion")],
        revision: 1,
        protected: false,
      },
      specRevision: 1,
    });
    const expiredState = emptyState([expiredTask]);
    expiredState.criteria.push(criterion("expired", "expired-criterion", "satisfied"));
    expect(deriveProjectWorkTaskPolicy(expiredState, expiredTask.taskId).claimability).toEqual({
      claimable: true,
    });
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

  it("does not allow completion while a required criterion is unsatisfied", () => {
    const state = emptyState([task("task-1", "in-progress")]);
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
    state.criteria.push(criterion("task-1", "criterion-1"));
    state.attempts.push({
      attemptId: ProjectWorkAttemptId.make("attempt-1"),
      taskId: ProjectWorkTaskId.make("task-1"),
      state: "running",
      checkpointIds: [],
      revision: 0,
    });
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.task.complete",
        commandId: CommandId.make("command-4"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        attemptId: ProjectWorkAttemptId.make("attempt-1"),
        satisfiedCriterionIds: [],
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/criterion/i);
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

  it("rebuilds attention from task lifecycle events and resolves it durably", () => {
    const state = emptyState([task("blocked-task")]);
    const blockedAt = "2026-01-01T00:01:00.000Z";
    const blockerId = ProjectWorkBlockerId.make("blocker-1");
    const blocked = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        type: "project-work.task.block",
        commandId: CommandId.make("block-command"),
        projectId,
        taskId: ProjectWorkTaskId.make("blocked-task"),
        blockerId,
        reason: "Waiting on access",
        resolver: "platform",
        referenceIds: [],
        blockedAt,
      }),
    );
    expect(blocked.attention).toEqual([
      expect.objectContaining({
        taskId: ProjectWorkTaskId.make("blocked-task"),
        reason: "blocked",
        detail: String(blockerId),
      }),
    ]);
    expect(blocked.attention[0]?.resolvedAt).toBeUndefined();

    const resolvedAt = "2026-01-01T00:02:00.000Z";
    const resolved = applyProjectWorkEvents(
      blocked,
      decideProjectWorkCommand(blocked, {
        type: "project-work.task.resolve-blocker",
        commandId: CommandId.make("resolve-blocker-command"),
        projectId,
        taskId: ProjectWorkTaskId.make("blocked-task"),
        blockerId,
        resolvedAt,
      }),
    );
    expect(resolved.attention).toEqual([
      expect.objectContaining({
        taskId: ProjectWorkTaskId.make("blocked-task"),
        reason: "blocked",
        resolvedAt,
      }),
    ]);

    const reopenedBlockerId = ProjectWorkBlockerId.make("blocker-2");
    const reopened = applyProjectWorkEvents(
      resolved,
      decideProjectWorkCommand(resolved, {
        type: "project-work.task.block",
        commandId: CommandId.make("reopen-block-command"),
        projectId,
        taskId: ProjectWorkTaskId.make("blocked-task"),
        blockerId: reopenedBlockerId,
        reason: "Waiting on another access grant",
        resolver: "platform",
        referenceIds: [],
        blockedAt: "2026-01-01T00:03:00.000Z",
      }),
    );
    expect(reopened.attention).toHaveLength(1);
    expect(reopened.attention[0]).toMatchObject({
      reason: "blocked",
      detail: String(reopenedBlockerId),
    });
    expect(reopened.attention[0]?.resolvedAt).toBeUndefined();
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

  it("rejects commands deferred to later phases with a typed policy error", () => {
    let failure: unknown;
    try {
      decideProjectWorkCommand(emptyState([task("task-1")]), {
        type: "project-work.comment.add",
        commandId: CommandId.make("command-deferred"),
        projectId,
        comment: {
          commentId: ProjectWorkCommentId.make("comment-1"),
          projectId,
          body: "Later",
          createdAt: "2026-01-01T00:00:00.000Z",
          revision: 0,
        },
        addedAt: "2026-01-01T00:00:00.000Z",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "deferred-command", _tag: "ProjectWorkPolicyError" });

    expect(() =>
      decideProjectWorkCommand(emptyState([task("task-1", "in-progress")]), {
        type: "project-work.task.fail",
        commandId: CommandId.make("command-failure-deferred"),
        projectId,
        taskId: ProjectWorkTaskId.make("task-1"),
        failureKind: "recoverable",
        reason: "Later",
        failedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(ProjectWorkPolicyError);
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

describe("human issue refinement", () => {
  const refinedAt = "2026-01-02T00:00:00.000Z";
  const issue = (patch: Partial<ProjectIssueIntake> = {}): ProjectIssueIntake => ({
    kind: "issue",
    recordId: "issue-1",
    projectId,
    revision: 4,
    generation: 3,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    identity: {
      host: "github.com",
      repositoryNodeId: "repository-node-1",
      issueNodeId: "issue-node-1",
      number: 17,
    },
    repositoryName: "maintainers/renamed-repository",
    title: "Original human title",
    body: "Original human body\nwith findings preserved externally",
    sourceRevision: "source-revision-9",
    observedAt: "2026-01-01T00:01:00.000Z",
    ...patch,
  });
  const stateWithIssue = (
    record = issue(),
    tasks: ReadonlyArray<ProjectWorkTask> = [],
  ): ProjectWorkReducerState => ({
    ...emptyProjectWorkReducerState(projectId),
    tasks: [...tasks],
    revision: 12,
    foundationRecords: [record],
    history: [
      {
        eventId: EventId.make("investigation-history"),
        type: "project-work.foundation.recorded",
        revision: 11,
        occurredAt: "2026-01-01T00:02:00.000Z",
      },
    ],
    comments: [
      {
        commentId: ProjectWorkCommentId.make("investigation-comment"),
        projectId,
        body: "Preserved internal investigation findings",
        revision: 0,
        createdAt: "2026-01-01T00:02:00.000Z",
        attribution,
      },
    ],
  });
  const refine = (
    target: ProjectWorkIssueRefineCommand["target"] = {
      kind: "new-task",
      taskId: ProjectWorkTaskId.make("refined-task"),
      title: "Refined human title",
      summary: "Agreed bounded work",
      deliverableKind: "code",
    },
  ): ProjectWorkIssueRefineCommand => ({
    type: "project-work.issue.refine",
    commandId: CommandId.make("refine-issue"),
    projectId,
    expectedRevision: 12,
    issueRecordId: "issue-1",
    expectedIssueRevision: 4,
    target,
    refinedAt,
    attribution,
  });
  const assertRejectedWithoutMutation = (
    state: ProjectWorkReducerState,
    command: ProjectWorkIssueRefineCommand,
    message: RegExp,
  ) => {
    const before = structuredClone(state);
    expect(() => decideProjectWorkCommand(state, command)).toThrow(message);
    expect(state).toEqual(before);
  };

  it.each(["code", "research", "plan", "review", "reminder", "non-code"] as const)(
    "creates a draft %s deliverable and links the original issue atomically",
    (deliverableKind) => {
      const state = stateWithIssue();
      const before = structuredClone(state);
      const command = refine({
        kind: "new-task",
        taskId: ProjectWorkTaskId.make("refined-task"),
        title: "Refined human title",
        summary: "Agreed bounded work",
        deliverableKind,
      });
      const events = decideProjectWorkCommand(state, command);
      expect(events.map((event) => event.type)).toEqual([
        "project-work.task.created",
        "project-work.foundation.recorded",
        "project-work.foundation.recorded",
      ]);
      expect(events.map((event) => event.revision)).toEqual([13, 14, 15]);
      expect(events.map((event) => event.eventId)).toEqual([
        "refine-issue:project-work:0",
        "refine-issue:project-work:1",
        "refine-issue:project-work:2",
      ]);
      expect(
        events.every((event) => event.projectId === projectId && event.occurredAt === refinedAt),
      ).toBe(true);
      expect(decideProjectWorkCommand(state, command)).toEqual(events);
      expect(state).toEqual(before);
      const next = applyProjectWorkEvents(state, events);
      expect(next.tasks).toEqual([
        {
          taskId: "refined-task",
          projectId,
          title: "Refined human title",
          summary: "Agreed bounded work",
          state: "draft",
          watchers: [],
          revision: 0,
          specRevision: 0,
          createdAt: refinedAt,
          updatedAt: refinedAt,
          attribution,
        },
      ]);
      expect(next.foundationRecords).toEqual([
        {
          recordId: projectTeamDerivedRecordId(command.commandId, "membership"),
          kind: "task-membership",
          projectId,
          taskId: "refined-task",
          deliverableKind,
          executionKind: deliverableKind === "code" ? "managed" : "human",
          status: "active",
          controlState: "active",
          revision: 0,
          generation: 0,
          updatedAt: refinedAt,
        },
        { ...issue(), taskId: "refined-task", revision: 5, updatedAt: refinedAt },
      ]);
      expect(next.attempts).toEqual([]);
      expect(next.history?.slice(0, 1)).toEqual(before.history);
      expect(next.comments).toEqual(before.comments);
      assertRejectedWithoutMutation(next, command, /revision/i);
    },
  );

  it("accepts an explicit closed-issue refinement and omits an absent task summary", () => {
    const state = stateWithIssue(issue({ status: "closed" }));
    const next = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(
        state,
        refine({
          kind: "new-task",
          taskId: ProjectWorkTaskId.make("refined-task"),
          title: "A human chose to refine this closed issue",
          deliverableKind: "non-code",
        }),
      ),
    );
    expect(next.tasks[0]?.summary).toBeUndefined();
    expect(next.foundationRecords?.find((record) => record.kind === "issue")).toEqual({
      ...issue({ status: "closed" }),
      taskId: "refined-task",
      revision: 5,
      updatedAt: refinedAt,
    });
  });

  it.each(["legacy", "managed", "human", "unclassified"] as const)(
    "links an existing %s task without changing its state, specification, membership or approval",
    (classification) => {
      const existing = {
        ...task("existing-task", "specified"),
        revision: 7,
        specRevision: 2,
        specification: {
          objective: "Existing scope",
          scopeIn: "Existing work",
          scopeOut: "Other work",
          criterionIds: [],
          protected: false,
          revision: 2,
        },
      };
      const state = stateWithIssue(issue(), [existing]);
      if (classification !== "unclassified")
        state.foundationRecords?.push({
          kind: "task-membership",
          recordId: "existing-membership",
          projectId,
          revision: 3,
          generation: 2,
          updatedAt: attribution.recordedAt,
          status: "active",
          taskId: existing.taskId,
          executionKind: classification,
          deliverableKind: classification === "human" ? "non-code" : "code",
        });
      state.foundationRecords?.push({
        kind: "gate",
        recordId: "existing-approval",
        projectId,
        revision: 1,
        generation: 0,
        updatedAt: attribution.recordedAt,
        status: "approved",
        taskId: existing.taskId,
        gate: "specification",
        specRevision: 2,
        planRevision: 0,
        contentHash: "existing-specification-hash",
        evidenceIds: [],
        attribution,
      });
      const before = structuredClone(state);
      const events = decideProjectWorkCommand(
        state,
        refine({
          kind: "existing-task",
          taskId: existing.taskId,
          expectedTaskRevision: 7,
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "project-work.foundation.recorded",
        eventId: "refine-issue:project-work:0",
        revision: 13,
        record: { ...issue(), taskId: existing.taskId, revision: 5, updatedAt: refinedAt },
      });
      const next = applyProjectWorkEvents(state, events);
      expect(next.tasks).toEqual(before.tasks);
      expect(next.foundationRecords?.filter((record) => record.kind !== "issue")).toEqual(
        before.foundationRecords?.filter((record) => record.kind !== "issue"),
      );
      expect(next.comments).toEqual(before.comments);
      expect(next.attempts).toEqual(before.attempts);
      expect(state).toEqual(before);
    },
  );

  it("creates only a draft mission and preserves source identity and internal findings", () => {
    const state = stateWithIssue();
    const command = refine({
      kind: "mission",
      title: "A larger mission",
      objective: "Several eventual deliverables",
    });
    const events = decideProjectWorkCommand(state, command);
    const missionId = projectTeamDerivedRecordId(command.commandId, "mission");
    expect(events.map((event) => event.type)).toEqual([
      "project-work.foundation.recorded",
      "project-work.foundation.recorded",
    ]);
    expect(events.map((event) => event.eventId)).toEqual([
      "refine-issue:project-work:0",
      "refine-issue:project-work:1",
    ]);
    expect(events.map((event) => event.revision)).toEqual([13, 14]);
    expect(decideProjectWorkCommand(state, command)).toEqual(events);
    const next = applyProjectWorkEvents(state, events);
    expect(next.foundationRecords).toEqual([
      {
        kind: "mission",
        recordId: missionId,
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: refinedAt,
        status: "draft",
        title: "A larger mission",
        objective: "Several eventual deliverables",
        requiredTaskIds: [],
      },
      { ...issue(), missionId, revision: 5, updatedAt: refinedAt },
    ]);
    expect(next.tasks).toEqual([]);
    expect(next.attempts).toEqual([]);
    expect(next.comments).toEqual(state.comments);
    expect(next.history?.slice(0, 1)).toEqual(state.history);
  });

  it.each(["new-task", "existing-task", "mission"] as const)(
    "requires human attribution before %s refinement",
    (kind) => {
      const target: ProjectWorkIssueRefineCommand["target"] =
        kind === "mission"
          ? { kind, title: "Mission", objective: "Objective" }
          : kind === "existing-task"
            ? { kind, taskId: ProjectWorkTaskId.make("existing-task"), expectedTaskRevision: 0 }
            : {
                kind,
                taskId: ProjectWorkTaskId.make("refined-task"),
                title: "Task",
                deliverableKind: "code",
              };
      for (const actorKind of ["agent", "system", "adapter"] as const) {
        assertRejectedWithoutMutation(
          stateWithIssue(issue(), [task("existing-task")]),
          {
            ...refine(target),
            attribution: { ...attribution, actor: { kind: actorKind, id: "other-actor" } },
          },
          /human|attribution/i,
        );
      }
      const { attribution: _origin, ...unattributed } = refine(target);
      assertRejectedWithoutMutation(
        stateWithIssue(issue(), [task("existing-task")]),
        unattributed,
        /human|attribution/i,
      );
    },
  );

  it("rejects stale project and issue revisions", () => {
    for (const expectedRevision of [0, 11, 13])
      assertRejectedWithoutMutation(
        stateWithIssue(),
        {
          ...refine(),
          expectedRevision,
        },
        /revision/i,
      );
    for (const expectedIssueRevision of [0, 3, 5])
      assertRejectedWithoutMutation(
        stateWithIssue(),
        {
          ...refine(),
          expectedIssueRevision,
        },
        /revision/i,
      );
  });

  it("rejects missing, foreign and detached issues before creating records", () => {
    assertRejectedWithoutMutation(
      { ...stateWithIssue(), foundationRecords: [] },
      refine(),
      /issue/i,
    );
    assertRejectedWithoutMutation(
      stateWithIssue(issue({ projectId: ProjectId.make("other-project") })),
      refine(),
      /project|issue/i,
    );
    assertRejectedWithoutMutation(
      stateWithIssue(issue({ status: "detached" })),
      refine(),
      /detached/i,
    );
    assertRejectedWithoutMutation(
      stateWithIssue(),
      { ...refine(), projectId: ProjectId.make("other-project") },
      /project/i,
    );
  });

  it.each([{ taskId: ProjectWorkTaskId.make("already-linked") }, { missionId: "already-linked" }])(
    "rejects an already linked issue %j even when the requested target matches",
    (link) => {
      const state = stateWithIssue(issue(link), [task("already-linked")]);
      assertRejectedWithoutMutation(
        state,
        refine({
          kind: "existing-task",
          taskId: ProjectWorkTaskId.make("already-linked"),
          expectedTaskRevision: 0,
        }),
        /linked/i,
      );
    },
  );

  it("rejects a record with the issue ID but another kind", () => {
    const state = stateWithIssue();
    state.foundationRecords = [
      {
        kind: "mission",
        recordId: "issue-1",
        projectId,
        status: "draft",
        revision: 4,
        generation: 0,
        updatedAt: refinedAt,
        title: "Other record",
        objective: "Other scope",
        requiredTaskIds: [],
      },
    ];
    assertRejectedWithoutMutation(state, refine(), /issue/i);
  });

  it("rejects a duplicate task ID or derived membership collision atomically", () => {
    assertRejectedWithoutMutation(
      stateWithIssue(issue(), [task("refined-task")]),
      refine(),
      /already|duplicate/i,
    );
    const state = stateWithIssue();
    state.foundationRecords?.push({
      kind: "mission",
      recordId: projectTeamDerivedRecordId(refine().commandId, "membership"),
      projectId,
      status: "draft",
      revision: 0,
      generation: 0,
      updatedAt: refinedAt,
      title: "Collision",
      objective: "Must survive",
      requiredTaskIds: [],
    });
    assertRejectedWithoutMutation(state, refine(), /identity|kind|revision|already/i);
  });

  it("rejects a derived mission ID collision without overwriting the old record", () => {
    const state = stateWithIssue();
    const command = refine({ kind: "mission", title: "New", objective: "New" });
    state.foundationRecords?.push({
      kind: "mission",
      recordId: projectTeamDerivedRecordId(command.commandId, "mission"),
      projectId,
      status: "draft",
      revision: 0,
      generation: 0,
      updatedAt: refinedAt,
      title: "Existing",
      objective: "Existing",
      requiredTaskIds: [],
    });
    assertRejectedWithoutMutation(state, command, /already|collision|duplicate/i);
  });

  it("rejects missing, foreign and stale existing tasks", () => {
    const command = refine({
      kind: "existing-task",
      taskId: ProjectWorkTaskId.make("existing-task"),
      expectedTaskRevision: 0,
    });
    assertRejectedWithoutMutation(stateWithIssue(), command, /task/i);
    assertRejectedWithoutMutation(
      stateWithIssue(issue(), [
        { ...task("existing-task"), projectId: ProjectId.make("other-project") },
      ]),
      command,
      /project|task/i,
    );
    assertRejectedWithoutMutation(
      stateWithIssue(issue(), [{ ...task("existing-task"), revision: 1 }]),
      command,
      /revision/i,
    );
  });

  it.each(["completed", "canceled"] as const)("rejects linking a %s existing task", (status) => {
    assertRejectedWithoutMutation(
      stateWithIssue(issue(), [task("existing-task", status)]),
      refine({
        kind: "existing-task",
        taskId: ProjectWorkTaskId.make("existing-task"),
        expectedTaskRevision: 0,
      }),
      /completed|canceled|terminal/i,
    );
  });

  it("validates the final issue before returning any created-task events", () => {
    const state = stateWithIssue(issue({ body: "x".repeat(32_001) }));
    assertRejectedWithoutMutation(state, refine(), /body|32000|32,000|length/i);
  });
});

describe("foundation attention reconciliation", () => {
  const at = "2026-01-03T00:00:00.000Z";
  const mission = (
    recordId: string,
    taskIds: ReadonlyArray<string> = [],
  ): Extract<ProjectTeamRecord, { kind: "mission" }> => ({
    kind: "mission",
    recordId,
    projectId,
    status: "active",
    revision: 0,
    generation: 0,
    updatedAt: at,
    title: recordId,
    objective: "Mission scope",
    requiredTaskIds: taskIds.map((id) => ProjectWorkTaskId.make(id)),
  });
  const membership = (
    taskId: string,
    missionId: string,
  ): Extract<ProjectTeamRecord, { kind: "task-membership" }> => ({
    kind: "task-membership",
    recordId: `membership-${taskId}`,
    projectId,
    status: "active",
    revision: 0,
    generation: 0,
    updatedAt: at,
    taskId: ProjectWorkTaskId.make(taskId),
    missionId,
    executionKind: "legacy",
    deliverableKind: "code",
  });
  const issue = (taskId?: string, missionId?: string): ProjectIssueIntake => ({
    kind: "issue",
    recordId: "attention-issue",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "open",
    title: "External issue",
    body: "Human text",
    sourceRevision: "source-1",
    observedAt: at,
    repositoryName: "maintainers/repository",
    identity: { host: "github.com", repositoryNodeId: "repo", issueNodeId: "issue", number: 1 },
    ...(taskId === undefined ? {} : { taskId: ProjectWorkTaskId.make(taskId) }),
    ...(missionId === undefined ? {} : { missionId }),
  });
  const foundationEvent = (record: ProjectTeamRecord, ordinal = 0): ProjectWorkEvent => ({
    type: "project-work.foundation.recorded",
    eventId: EventId.make(`foundation-attention:${ordinal}`),
    projectId,
    revision: ordinal + 1,
    occurredAt: at,
    record,
  });
  const blockedState = (records: ReadonlyArray<ProjectTeamRecord>): ProjectWorkReducerState => ({
    ...emptyProjectWorkReducerState(projectId),
    tasks: [
      task("old-task", "blocked"),
      task("new-task", "blocked"),
      task("member-task", "blocked"),
      task("unrelated", "blocked"),
    ],
    foundationRecords: [...records],
  });

  it("reconciles old and new issue links plus the affected mission edges only", () => {
    const state = blockedState([
      issue("old-task"),
      mission("mission", ["new-task"]),
      membership("member-task", "mission"),
    ]);
    const next = applyProjectWorkEvents(state, [foundationEvent(issue(undefined, "mission"))]);
    expect(next.attention.map((entry) => entry.taskId).sort()).toEqual([
      "member-task",
      "new-task",
      "old-task",
    ]);
    expect(next.tasks).toEqual(state.tasks);
    expect(state.attention).toEqual([]);
  });

  it("reconciles former issue edges when the issue becomes detached and loses links", () => {
    const state = blockedState([issue("old-task")]);
    const record = { ...issue(), status: "detached" as const };
    const next = applyProjectWorkEvents(state, [foundationEvent(record)]);
    expect(next.attention.map((entry) => entry.taskId)).toEqual(["old-task"]);
  });

  it("reconciles old and new required tasks and active memberships on mission updates", () => {
    const state = blockedState([
      mission("mission", ["old-task"]),
      membership("member-task", "mission"),
      { ...membership("unrelated", "mission"), status: "removed" },
    ]);
    const next = applyProjectWorkEvents(state, [
      foundationEvent({ ...mission("mission", ["new-task"]), status: "completed" }),
    ]);
    expect(next.attention.map((entry) => entry.taskId).sort()).toEqual([
      "member-task",
      "new-task",
      "old-task",
    ]);
  });

  it("reconciles both membership task edges without touching unrelated tasks", () => {
    const state = blockedState([membership("old-task", "mission")]);
    const next = applyProjectWorkEvents(state, [
      foundationEvent({
        ...membership("new-task", "mission"),
        recordId: "membership-old-task",
        status: "removed",
      }),
    ]);
    expect(next.attention.map((entry) => entry.taskId).sort()).toEqual(["new-task", "old-task"]);
  });

  it("does not derive attention from foreign foundation records or task rows", () => {
    const foreign = ProjectId.make("foreign");
    const state = blockedState([]);
    state.tasks = state.tasks.map((entry) =>
      entry.taskId === "old-task" ? { ...entry, projectId: foreign } : entry,
    );
    const next = applyProjectWorkEvents(state, [foundationEvent(issue("old-task"))]);
    expect(next.attention).toEqual([]);
    const foreignRecord = applyProjectWorkEvents(blockedState([]), [
      foundationEvent({ ...issue("new-task"), projectId: foreign }),
    ]);
    expect(foreignRecord.attention).toEqual([]);
  });

  it("does not recompute task attention for an unrelated foundation record", () => {
    const next = applyProjectWorkEvents(blockedState([]), [
      foundationEvent({
        kind: "intake-cursor",
        recordId: "cursor",
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "ready",
        host: "github.com",
        repositoryNodeId: "repo",
        accountId: "account",
        overlapSince: at,
      }),
    ]);
    expect(next.attention).toEqual([]);
  });

  it("starts a fresh occurrence above the prior resolved revision without a task revision change", () => {
    const state = blockedState([issue("old-task")]);
    state.attention = [
      {
        taskId: ProjectWorkTaskId.make("old-task"),
        reason: "blocked",
        revision: 7,
        seenAt: at,
        resolvedAt: at,
      },
    ];
    const next = applyProjectWorkEvents(state, [foundationEvent(issue("old-task"))]);
    expect(next.attention).toEqual([{ taskId: "old-task", reason: "blocked", revision: 8 }]);
    expect(next.tasks).toEqual(state.tasks);
  });

  it("clears seen state and advances occurrence when reason detail changes", () => {
    const state = blockedState([issue("old-task")]);
    state.attention = [
      {
        taskId: ProjectWorkTaskId.make("old-task"),
        reason: "blocked",
        detail: "old blocker",
        revision: 7,
        seenAt: at,
      },
    ];
    const next = applyProjectWorkEvents(state, [foundationEvent(issue("old-task"))]);
    expect(next.attention).toEqual([{ taskId: "old-task", reason: "blocked", revision: 8 }]);
  });

  it("preserves a seen occurrence when reason and detail are unchanged", () => {
    const state = blockedState([issue("old-task")]);
    state.attention = [
      { taskId: ProjectWorkTaskId.make("old-task"), reason: "blocked", revision: 7, seenAt: at },
    ];
    const next = applyProjectWorkEvents(state, [foundationEvent(issue("old-task"))]);
    expect(next.attention).toEqual(state.attention);
  });

  const markSeen = (state: ProjectWorkReducerState, taskId = "old-task") =>
    applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        type: "project-work.attention.seen",
        commandId: CommandId.make(`mark-seen-${state.revision}`),
        projectId,
        taskId: ProjectWorkTaskId.make(taskId),
        expectedRevision: state.revision,
        seenAt: at,
        attribution,
      }),
    );
  const draftState = (records: ReadonlyArray<ProjectTeamRecord>): ProjectWorkReducerState => ({
    ...emptyProjectWorkReducerState(projectId),
    tasks: [task("old-task"), task("new-task"), task("member-task"), task("unrelated")],
    foundationRecords: [...records],
  });

  it("resolves opening and creates an unread occurrence on reclose without changing task revisions", () => {
    const state = draftState([issue("old-task")]);
    const closed = applyProjectWorkEvents(state, [
      foundationEvent({ ...issue("old-task"), status: "closed", revision: 1 }),
    ]);
    expect(closed.attention).toEqual([
      {
        taskId: "old-task",
        reason: "external-issue-closed",
        detail: "Linked issue 'attention-issue' is closed.",
        revision: 0,
      },
    ]);
    const seen = markSeen(closed);
    expect(seen.attention[0]).toMatchObject({ seenAt: at, revision: 1 });
    const opened = applyProjectWorkEvents(seen, [
      foundationEvent({ ...issue("old-task"), revision: 2 }, 2),
    ]);
    expect(opened.attention[0]).toMatchObject({ resolvedAt: at, seenAt: at, revision: 2 });
    const reclosed = applyProjectWorkEvents(opened, [
      foundationEvent({ ...issue("old-task"), status: "closed", revision: 3 }, 3),
    ]);
    expect(reclosed.attention).toEqual([
      {
        taskId: "old-task",
        reason: "external-issue-closed",
        detail: "Linked issue 'attention-issue' is closed.",
        revision: 3,
      },
    ]);
    expect(reclosed.tasks).toEqual(state.tasks);
    expect(reclosed.attempts).toEqual([]);
    expect(reclosed.foundationRecords?.every((record) => record.kind === "issue")).toBe(true);
  });

  it("makes closure and recovered blocker reasons separate unread occurrences", () => {
    const state = blockedState([issue("old-task")]);
    const closed = markSeen(
      applyProjectWorkEvents(state, [foundationEvent({ ...issue("old-task"), status: "closed" })]),
    );
    const opened = applyProjectWorkEvents(closed, [foundationEvent(issue("old-task"), 2)]);
    expect(opened.attention).toEqual([{ taskId: "old-task", reason: "blocked", revision: 2 }]);
    const seen = markSeen(opened);
    expect(seen.attention[0]).toMatchObject({ seenAt: at, revision: 3 });
    const reclosed = applyProjectWorkEvents(seen, [
      foundationEvent({ ...issue("old-task"), status: "closed" }, 4),
    ]);
    expect(reclosed.attention).toEqual([
      {
        taskId: "old-task",
        reason: "external-issue-closed",
        detail: "Linked issue 'attention-issue' is closed.",
        revision: 4,
      },
    ]);
    expect(reclosed.tasks).toEqual(state.tasks);
  });

  it("preserves seen closure through source edits and clears it when the representative issue changes", () => {
    const state = draftState([issue("old-task")]);
    const closed = markSeen(
      applyProjectWorkEvents(state, [foundationEvent({ ...issue("old-task"), status: "closed" })]),
    );
    const edited = applyProjectWorkEvents(closed, [
      foundationEvent(
        {
          ...issue("old-task"),
          status: "closed",
          title: "Changed title",
          body: "Changed body",
          repositoryName: "maintainers/renamed",
          sourceRevision: "source-2",
          revision: 1,
        },
        2,
      ),
    ]);
    expect(edited.attention).toEqual(closed.attention);
    const changed = applyProjectWorkEvents(edited, [
      foundationEvent(
        {
          ...issue("old-task"),
          status: "closed",
          recordId: "aaa-issue",
          identity: { ...issue().identity, issueNodeId: "second-issue", number: 2 },
        },
        3,
      ),
    ]);
    expect(changed.attention).toEqual([
      {
        taskId: "old-task",
        reason: "external-issue-closed",
        detail: "Linked issue 'aaa-issue' is closed.",
        revision: 2,
      },
    ]);
    expect(changed.tasks).toEqual(state.tasks);
  });

  it("resolves former direct issue links after rebinding and detachment", () => {
    const state = draftState([issue("old-task")]);
    const closed = applyProjectWorkEvents(state, [
      foundationEvent({ ...issue("old-task"), status: "closed" }),
    ]);
    const rebound = applyProjectWorkEvents(closed, [
      foundationEvent({ ...issue("new-task"), status: "closed", revision: 1 }, 1),
    ]);
    expect(rebound.attention).toEqual([
      {
        taskId: "old-task",
        reason: "external-issue-closed",
        detail: "Linked issue 'attention-issue' is closed.",
        revision: 1,
        resolvedAt: at,
      },
      {
        taskId: "new-task",
        reason: "external-issue-closed",
        detail: "Linked issue 'attention-issue' is closed.",
        revision: 0,
      },
    ]);
    const detached = applyProjectWorkEvents(rebound, [
      foundationEvent({ ...issue(), status: "detached", revision: 2 }, 2),
    ]);
    expect(detached.attention.every((entry) => entry.resolvedAt === at)).toBe(true);
    expect(detached.attention.map((entry) => entry.revision)).toEqual([1, 1]);
    expect(detached.tasks).toEqual(state.tasks);
  });

  it("refreshes closure for changed mission requirements, removed memberships and mission completion", () => {
    const state = draftState([
      issue(undefined, "mission"),
      mission("mission", ["old-task"]),
      membership("member-task", "mission"),
    ]);
    const closed = applyProjectWorkEvents(state, [
      foundationEvent({ ...issue(undefined, "mission"), status: "closed" }),
    ]);
    expect(closed.attention.map((entry) => entry.taskId).sort()).toEqual([
      "member-task",
      "old-task",
    ]);
    const changed = applyProjectWorkEvents(closed, [
      foundationEvent({ ...mission("mission", ["new-task"]), revision: 1 }, 1),
    ]);
    expect(changed.attention.find((entry) => entry.taskId === "old-task")).toMatchObject({
      resolvedAt: at,
      revision: 1,
    });
    expect(
      changed.attention
        .filter((entry) => entry.resolvedAt === undefined)
        .map((entry) => entry.taskId)
        .sort(),
    ).toEqual(["member-task", "new-task"]);
    const removed = applyProjectWorkEvents(changed, [
      foundationEvent(
        { ...membership("member-task", "mission"), status: "removed", revision: 1 },
        2,
      ),
    ]);
    expect(removed.attention.find((entry) => entry.taskId === "member-task")).toMatchObject({
      resolvedAt: at,
      revision: 1,
    });
    const completed = applyProjectWorkEvents(removed, [
      foundationEvent({ ...mission("mission", ["new-task"]), status: "completed", revision: 2 }, 3),
    ]);
    expect(completed.attention.every((entry) => entry.resolvedAt === at)).toBe(true);
    expect(completed.attention.some((entry) => entry.taskId === "unrelated")).toBe(false);
    expect(completed.tasks).toEqual(state.tasks);
    expect(completed.attempts).toEqual([]);
  });
});
