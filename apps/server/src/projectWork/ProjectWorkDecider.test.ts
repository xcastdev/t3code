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
  projectWorkPayloadFingerprint,
  type ProjectWorkAttribution,
  type ProjectWorkCriterion,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  type ProjectWorkReducerState,
  type ProjectWorkState,
} from "./ProjectWorkDecider.ts";
import { deriveProjectWorkTaskPolicy, ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

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
