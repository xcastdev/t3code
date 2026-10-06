import type { ProjectTeamRecord } from "@t3tools/contracts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import { decideProjectTeamGuidedLifecycle } from "./ProjectTeamGuidedLifecycle.ts";
import { decideProjectTeamMemoryReflection } from "./ProjectTeamMemoryTransitions.ts";
import { decideProjectTeamPublicationTransition } from "./ProjectTeamPublicationTransitions.ts";
import { decideProjectTeamGuidedTransition } from "./ProjectTeamGuidedTransitions.ts";
import { isGuidedProjectTeamTask, projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import {
  EventId,
  ProjectWorkAttemptId,
  ProjectWorkBlockerId,
  ProjectWorkCriterionId,
  ProjectWorkRelationshipId,
  canonicalProjectWorkPayload,
  ProjectWorkTaskId,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkCommentId,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
  type ProjectWorkApproval,
  type ProjectWorkAttribution,
  type ProjectWorkAttempt,
  type ProjectWorkBlocker,
  type ProjectWorkCommand,
  type ProjectWorkCriterion,
  type ProjectWorkEvidence,
  type ProjectWorkRelationship,
  type ProjectWorkTask,
  type ProjectWorkTaskState,
  type ProjectWorkProtectedSpecificationApproval,
  type ProjectWorkResultInvalidation,
  type ProjectWorkResultId,
  type ProjectWorkKnowledge,
  type ProjectWorkDecision,
  type ProjectWorkComment,
  type ProjectWorkAttention,
} from "@t3tools/contracts";

import {
  assertKnownBlocker,
  assertKnownCriterion,
  assertKnownTask,
  assertNoActiveAttempt,
  assertProjectWorkAttribution,
  assertProjectWorkExpectedRevision,
  assertTaskCanBeCompleted,
  assertTaskCanBeReady,
  deriveProjectWorkTaskPolicy,
  findProjectWorkDependencyCycle,
  projectWorkActorKey,
  ProjectWorkPolicyError,
} from "./ProjectWorkPolicy.ts";
import type { ProjectWorkState } from "./ProjectWorkPolicy.ts";

export type { ProjectWorkState } from "./ProjectWorkPolicy.ts";

/** Append-only checkpoint retained independently of the task row. */
export interface ProjectWorkCheckpoint {
  readonly checkpointId: string;
  readonly projectId: string;
  readonly taskId: ProjectWorkTaskId;
  readonly attemptId: ProjectWorkAttemptId;
  readonly ref?: string;
  readonly capturedAt: string;
  readonly revision: number;
  readonly attribution?: ProjectWorkAttribution;
}

/** Stable timeline record derived from each project-work event. */
export interface ProjectWorkActivity {
  readonly activityId: string;
  readonly projectId: string;
  readonly taskId?: ProjectWorkTaskId;
  readonly attemptId?: ProjectWorkAttemptId;
  readonly kind: string;
  readonly summary: string;
  readonly detail?: string;
  readonly occurredAt: string;
  readonly revision: number;
  readonly attribution?: ProjectWorkAttribution;
}

/** A durable history row kept by the pure reducer for audit and rebuilds. */
export interface ProjectWorkHistoryEntry {
  readonly eventId: EventId;
  readonly type: ProjectWorkEvent["type"];
  readonly revision: number;
  readonly occurredAt: string;
}

export interface ProjectWorkReducerState extends ProjectWorkState {
  foundationRecords?: Array<ProjectTeamRecord>;
  history?: Array<ProjectWorkHistoryEntry>;
  resultInvalidations?: Array<ProjectWorkResultInvalidation>;
  checkpoints?: Array<ProjectWorkCheckpoint>;
  activities?: Array<ProjectWorkActivity>;
  knowledge?: Array<ProjectWorkKnowledge>;
  decisions?: Array<ProjectWorkDecision>;
  comments?: Array<ProjectWorkComment>;
}

export const emptyProjectWorkReducerState = (projectId: string): ProjectWorkReducerState => ({
  projectId,
  foundationRecords: [],
  revision: 0,
  tasks: [],
  attempts: [],
  criteria: [],
  evidence: [],
  relationships: [],
  blockers: [],
  attention: [],
  checkpoints: [],
  activities: [],
  knowledge: [],
  decisions: [],
  comments: [],
  history: [],
  resultInvalidations: [],
});

type EventBase = {
  readonly eventId: EventId;
  readonly projectId: string;
  readonly revision: number;
  readonly occurredAt: string;
};

export type ProjectWorkEvent =
  | (EventBase & {
      readonly type: "project-work.foundation.recorded";
      readonly record: ProjectTeamRecord;
    })
  | (EventBase & { readonly type: "project-work.task.created"; readonly task: ProjectWorkTask })
  | (EventBase & {
      readonly type: "project-work.task.specified";
      readonly taskId: ProjectWorkTaskId;
      readonly specification: NonNullable<ProjectWorkTask["specification"]>;
      readonly updatedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.specification-revised";
      readonly taskId: ProjectWorkTaskId;
      readonly specification: NonNullable<ProjectWorkTask["specification"]>;
      readonly criterionSnapshots: ReadonlyArray<ProjectWorkCriterion>;
      readonly approval: ProjectWorkProtectedSpecificationApproval;
      readonly affectedResultIds: ReadonlyArray<ProjectWorkResultId>;
      readonly resultInvalidations: ReadonlyArray<ProjectWorkResultInvalidation>;
      readonly state: Extract<ProjectWorkTaskState, "specified" | "ready">;
      readonly revisedAt: string;
    })
  | (EventBase & { readonly type: "project-work.task.ready"; readonly taskId: ProjectWorkTaskId })
  | (EventBase & {
      readonly type: "project-work.task.claimed";
      readonly taskId: ProjectWorkTaskId;
      readonly attempt: ProjectWorkAttempt;
    })
  | (EventBase & {
      readonly type: "project-work.task.completed";
      readonly taskId: ProjectWorkTaskId;
      readonly attemptId?: ProjectWorkAttemptId;
      readonly satisfiedCriterionIds: ReadonlyArray<ProjectWorkCriterionId>;
      readonly completedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.failed";
      readonly taskId: ProjectWorkTaskId;
      readonly attemptId?: ProjectWorkAttemptId;
      readonly failureKind: "recoverable" | "manual-triage" | "lease-expired";
      readonly reason: string;
      readonly evidenceIds: ReadonlyArray<string>;
      readonly failedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.attempt.stopped";
      readonly taskId: ProjectWorkTaskId;
      readonly attemptId: ProjectWorkAttemptId;
      readonly bindingId: string;
      readonly receiptId: string;
      readonly stoppedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.failure-resolved";
      readonly taskId: ProjectWorkTaskId;
      readonly failedAttemptId?: ProjectWorkAttemptId;
      readonly reason: string;
      readonly evidenceIds: ReadonlyArray<string>;
      readonly resolvedAt: string;
      readonly state: Extract<ProjectWorkTaskState, "specified" | "ready">;
      readonly attribution: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.task.blocked";
      readonly taskId: ProjectWorkTaskId;
      readonly blocker: ProjectWorkBlocker;
      readonly blockedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.blocker-resolved";
      readonly taskId: ProjectWorkTaskId;
      readonly blockerId: ProjectWorkBlockerId;
      readonly resolvedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.reopened";
      readonly taskId: ProjectWorkTaskId;
      readonly reopenedAt: string;
      readonly state: Extract<ProjectWorkTaskState, "draft" | "specified" | "ready">;
    })
  | (EventBase & {
      readonly type: "project-work.task.canceled";
      readonly taskId: ProjectWorkTaskId;
      readonly canceledAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.duplicated";
      readonly sourceTaskId: ProjectWorkTaskId;
      readonly task: ProjectWorkTask;
      readonly relationship: ProjectWorkRelationship;
      readonly duplicatedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.approved";
      readonly taskId: ProjectWorkTaskId;
      readonly approval: ProjectWorkApproval;
      readonly approvedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.assigned";
      readonly taskId: ProjectWorkTaskId;
      readonly assignee: ProjectWorkTask["assignee"];
      readonly assignedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.watched";
      readonly taskId: ProjectWorkTaskId;
      readonly watcher: NonNullable<ProjectWorkTask["watchers"]>[number];
      readonly watchedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.unwatched";
      readonly taskId: ProjectWorkTaskId;
      readonly watcher: NonNullable<ProjectWorkTask["watchers"]>[number];
      readonly unwatchedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.task.specification-protected";
      readonly taskId: ProjectWorkTaskId;
      readonly specRevision: number;
      readonly protectedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.criterion.upserted";
      readonly taskId: ProjectWorkTaskId;
      readonly criterion: ProjectWorkCriterion;
      readonly updatedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.criterion.waived";
      readonly taskId: ProjectWorkTaskId;
      readonly criterionId: ProjectWorkCriterionId;
      readonly waiver: NonNullable<ProjectWorkCriterion["waiver"]>;
      readonly waivedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.evidence.added";
      readonly evidence: ProjectWorkEvidence;
      readonly addedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.relationship.linked";
      readonly relationship: ProjectWorkRelationship;
      readonly linkedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.relationship.unlinked";
      readonly relationshipId: ProjectWorkRelationshipId;
      readonly unlinkedAt: string;
    })
  | (EventBase & {
      readonly type: "project-work.attempt.renewed";
      readonly taskId: ProjectWorkTaskId;
      readonly attemptId: ProjectWorkAttemptId;
      readonly leaseToken: string;
      readonly leasedUntil: string;
      readonly renewedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.attempt.checkpointed";
      readonly checkpoint: ProjectWorkCheckpoint;
    })
  | (EventBase & {
      readonly type: "project-work.attempt.expired";
      readonly taskId: ProjectWorkTaskId;
      readonly attemptId: ProjectWorkAttemptId;
      readonly reason: string;
      readonly expiredAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.attempt.reclaimed";
      readonly taskId: ProjectWorkTaskId;
      readonly previousAttemptId: ProjectWorkAttemptId;
      readonly attempt: ProjectWorkAttempt;
      readonly reclaimedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.attempt.taken-over";
      readonly taskId: ProjectWorkTaskId;
      readonly previousAttemptId: ProjectWorkAttemptId;
      readonly attempt: ProjectWorkAttempt;
      readonly takeoverAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.activity.recorded";
      readonly activity: ProjectWorkActivity;
    })
  | (EventBase & {
      readonly type: "project-work.knowledge.promoted";
      readonly knowledge: ProjectWorkKnowledge;
      readonly promotedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.decision.proposed";
      readonly decision: ProjectWorkDecision;
      readonly proposedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.decision.accepted";
      readonly decisionId: import("@t3tools/contracts").ProjectWorkDecisionId;
      readonly acceptedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.decision.rejected";
      readonly decisionId: import("@t3tools/contracts").ProjectWorkDecisionId;
      readonly reason: string;
      readonly rejectedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.decision.superseded";
      readonly decisionId: import("@t3tools/contracts").ProjectWorkDecisionId;
      readonly replacement: ProjectWorkDecision;
      readonly supersededAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.comment.added";
      readonly comment: ProjectWorkComment;
      readonly addedAt: string;
      readonly attribution?: ProjectWorkAttribution;
    })
  | (EventBase & {
      readonly type: "project-work.attention.seen";
      readonly taskId: ProjectWorkTaskId;
      readonly seenAt: string;
      readonly attribution?: ProjectWorkAttribution;
    });

export type ProjectWorkDeferredCommandType = never;

const eventIdFor = (commandId: string, index: number): EventId =>
  EventId.make(`${commandId}:project-work:${index}`);

const activeAttempt = (
  state: ProjectWorkState,
  taskId: ProjectWorkTaskId,
): ProjectWorkAttempt | undefined =>
  state.attempts.find(
    (attempt) =>
      attempt.taskId === taskId && (attempt.state === "leased" || attempt.state === "running"),
  );

const leaseExpired = (attempt: ProjectWorkAttempt, now: string): boolean =>
  attempt.leasedUntil !== undefined && Date.parse(attempt.leasedUntil) <= Date.parse(now);

const assertLease = (
  state: ProjectWorkState,
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  token: string,
  now: string,
): ProjectWorkAttempt => {
  const attempt = state.attempts.find((entry) => entry.attemptId === attemptId);
  if (attempt === undefined || attempt.taskId !== taskId)
    throw new ProjectWorkPolicyError("invalid-state", "Attempt does not belong to this task.", {
      taskId,
      attemptId,
    });
  if (attempt.state !== "leased" && attempt.state !== "running")
    throw new ProjectWorkPolicyError(
      "invalid-state",
      `Attempt '${attemptId}' is ${attempt.state}.`,
      {
        attemptId,
      },
    );
  const current = activeAttempt(state, taskId);
  if (current === undefined || current.attemptId !== attemptId)
    throw new ProjectWorkPolicyError(
      "authority-required",
      "The attempt is not the current active attempt for this task.",
      { taskId, attemptId },
    );
  if (attempt.leaseToken !== token)
    throw new ProjectWorkPolicyError(
      "authority-required",
      "The lease token does not match the active attempt.",
      {
        attemptId,
      },
    );
  if (leaseExpired(attempt, now))
    throw new ProjectWorkPolicyError("invalid-state", "The attempt lease has expired.", {
      attemptId,
      leasedUntil: attempt.leasedUntil,
    });
  return attempt;
};

const taskCopy = (
  task: ProjectWorkTask,
  patch: { [Key in keyof ProjectWorkTask]?: ProjectWorkTask[Key] | undefined },
): ProjectWorkTask =>
  Object.fromEntries(
    Object.entries({ ...task, ...patch }).filter(([, value]) => value !== undefined),
  ) as ProjectWorkTask;

const currentTask = (state: ProjectWorkState, taskId: ProjectWorkTaskId): ProjectWorkTask =>
  assertKnownTask(state, taskId);

const stateForRecords = <K extends "knowledge" | "decisions" | "comments">(
  state: ProjectWorkState,
  key: K,
): ReadonlyArray<
  K extends "knowledge"
    ? ProjectWorkKnowledge
    : K extends "decisions"
      ? ProjectWorkDecision
      : ProjectWorkComment
> =>
  ((state as ProjectWorkReducerState)[key] ?? []) as unknown as ReadonlyArray<
    K extends "knowledge"
      ? ProjectWorkKnowledge
      : K extends "decisions"
        ? ProjectWorkDecision
        : ProjectWorkComment
  >;

const assertProject = (state: ProjectWorkState, projectId: string, commandType: string): void => {
  if (state.projectId !== projectId) {
    throw new ProjectWorkPolicyError(
      "invalid-state",
      `${commandType} targets project '${projectId}', expected '${state.projectId}'.`,
      { commandType, projectId, currentProjectId: state.projectId },
    );
  }
};

const assertTaskMutable = (task: ProjectWorkTask, commandType: string): void => {
  if (task.state === "canceled") {
    throw new ProjectWorkPolicyError("invalid-state", `Task '${task.taskId}' is canceled.`, {
      taskId: task.taskId,
      commandType,
    });
  }
};

const assertProtectedSpecificationMutable = (task: ProjectWorkTask, commandType: string): void => {
  if (task.specification?.protected === true) {
    throw new ProjectWorkPolicyError(
      "protected-specification",
      `Task '${task.taskId}' has a protected specification; use an approved protected revision.`,
      { taskId: task.taskId, commandType, specRevision: task.specification.revision },
    );
  }
};

const assertCriterionBelongsToTask = (
  criterion: ProjectWorkCriterion,
  taskId: ProjectWorkTaskId,
): void => {
  if (criterion.taskId !== taskId) {
    throw new ProjectWorkPolicyError(
      "invalid-specification",
      `Criterion '${criterion.criterionId}' belongs to another task.`,
      { criterionId: criterion.criterionId, taskId },
    );
  }
};

const assertRelationshipTasks = (
  state: ProjectWorkState,
  relationship: ProjectWorkRelationship,
): void => {
  if (relationship.projectId !== state.projectId) {
    throw new ProjectWorkPolicyError(
      "invalid-relationship",
      `Relationship '${relationship.relationshipId}' targets project '${relationship.projectId}', expected '${state.projectId}'.`,
      { relationshipId: relationship.relationshipId, projectId: relationship.projectId },
    );
  }
  assertKnownTask(state, relationship.fromTaskId);
  assertKnownTask(state, relationship.toTaskId);
  if (relationship.fromTaskId === relationship.toTaskId) {
    throw new ProjectWorkPolicyError("invalid-relationship", "A task cannot relate to itself.", {
      taskId: relationship.fromTaskId,
    });
  }
  if (state.relationships.some((entry) => entry.relationshipId === relationship.relationshipId)) {
    throw new ProjectWorkPolicyError(
      "duplicate-record",
      `Relationship '${relationship.relationshipId}' already exists.`,
      { relationshipId: relationship.relationshipId },
    );
  }
  if (
    (relationship.kind === "depends-on" || relationship.kind === "blocks") &&
    findProjectWorkDependencyCycle(state, relationship.fromTaskId, relationship.toTaskId) !==
      undefined
  ) {
    const cycle = findProjectWorkDependencyCycle(
      state,
      relationship.fromTaskId,
      relationship.toTaskId,
    );
    throw new ProjectWorkPolicyError(
      "invalid-relationship",
      `The relationship would create a dependency cycle: ${cycle?.join(" -> ") ?? "unknown"}.`,
      {
        relationshipId: relationship.relationshipId,
        cycle,
      },
    );
  }
};

const assertUniqueId = (values: ReadonlyArray<string>, id: string, label: string): void => {
  if (values.includes(id)) {
    throw new ProjectWorkPolicyError("duplicate-record", `${label} '${id}' already exists.`, {
      id,
    });
  }
};

const assertUniqueValues = (
  values: ReadonlyArray<string>,
  label: string,
  details?: Readonly<Record<string, unknown>>,
): void => {
  if (new Set(values).size !== values.length) {
    throw new ProjectWorkPolicyError("duplicate-record", `${label} must be unique.`, details);
  }
};

type EventDraft = {
  readonly type: ProjectWorkEvent["type"];
  readonly occurredAt: string;
  readonly [key: string]: unknown;
};

const withEventMetadata = (
  commandId: string,
  projectId: string,
  revision: number,
  index: number,
  draft: EventDraft,
): ProjectWorkEvent =>
  ({
    ...draft,
    eventId: eventIdFor(commandId, index),
    projectId,
    revision,
  }) as ProjectWorkEvent;

/**
 * Decides one project-work write intent without clocks, persistence, or auth.
 * Every event timestamp is copied from the command that caused it.
 */
export function decideProjectWorkCommand(
  state: ProjectWorkState,
  command: ProjectWorkCommand,
): ReadonlyArray<ProjectWorkEvent> {
  // Keep the pre-P4 direct-decider contract deterministic for un-attributed
  // legacy callers. Repository callers supply attribution for lifecycle
  // writes, which are fully supported below.
  if (
    (command.type === "project-work.task.fail" || command.type === "project-work.comment.add") &&
    command.attribution === undefined
  ) {
    throw new ProjectWorkPolicyError(
      "deferred-command",
      `Command '${command.type}' requires attribution.`,
      {
        commandType: command.type,
      },
    );
  }
  assertProject(state, command.projectId, command.type);
  assertProjectWorkExpectedRevision(state, command.expectedRevision, command.type);
  const commandId = String(command.commandId);
  const event = <T extends EventDraft>(draft: T, index = 0): ProjectWorkEvent =>
    withEventMetadata(commandId, state.projectId, state.revision + index + 1, index, draft);

  if (command.type !== "project-work.foundation.commit") {
    const allowed = new Set([
      "project-work.task.watch",
      "project-work.task.unwatch",
      "project-work.evidence.add",
      "project-work.comment.add",
      "project-work.attention.seen",
      "project-work.attempt.renew",
      "project-work.attempt.checkpoint",
      "project-work.attempt.expire",
    ]);
    const targets =
      "taskId" in command
        ? [command.taskId]
        : command.type === "project-work.relationship.link"
          ? [command.relationship.fromTaskId, command.relationship.toTaskId]
          : command.type === "project-work.relationship.unlink"
            ? state.relationships
                .filter((r) => r.relationshipId === command.relationshipId)
                .flatMap((r) => [r.fromTaskId, r.toTaskId])
            : [];
    if (
      !allowed.has(command.type) &&
      targets.some((taskId) => isGuidedProjectTeamTask(state, taskId))
    )
      throw new ProjectWorkPolicyError(
        "authority-required",
        "Managed lifecycle requires an authenticated guided transition",
      );
    if (
      (command.type === "project-work.attempt.renew" ||
        command.type === "project-work.attempt.checkpoint") &&
      isGuidedProjectTeamTask(state, command.taskId)
    ) {
      const bindings = (state.foundationRecords ?? []).filter(
        (r) =>
          r.kind === "run-binding" &&
          r.taskId === command.taskId &&
          r.attemptId === command.attemptId,
      );
      if (bindings.length !== 1 || bindings[0]?.status !== "running")
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Managed run is stopped or no longer current",
        );
    }
  }

  switch (command.type) {
    case "project-work.issue.refine": {
      const origin = assertProjectWorkAttribution(command.attribution, command.type);
      let working = mutableState(state);
      const issue = working.foundationRecords?.find(
        (record) => record.recordId === command.issueRecordId,
      );
      if (issue?.kind !== "issue" || issue.projectId !== command.projectId)
        throw new ProjectWorkPolicyError("invalid-state", "Unknown issue in this project");
      if (issue.revision !== command.expectedIssueRevision)
        throw new ProjectWorkPolicyError("stale-revision", "Issue revision is stale");
      if (issue.status === "detached")
        throw new ProjectWorkPolicyError("invalid-state", "Detached issues cannot be refined");
      if (issue.taskId !== undefined || issue.missionId !== undefined)
        throw new ProjectWorkPolicyError("invalid-state", "Issue is already linked to work");

      const events: Array<ProjectWorkEvent> = [];
      const record = (input: ProjectTeamRecord) => {
        const validated = validateProjectTeamRecord(working, input, origin);
        const recorded = event(
          {
            type: "project-work.foundation.recorded",
            record: validated,
            occurredAt: command.refinedAt,
          },
          events.length,
        );
        events.push(recorded);
        working = applyProjectWorkEvents(working, [recorded]);
      };
      const target = command.target;
      if (target.kind === "mission") {
        const missionId = projectTeamDerivedRecordId(command.commandId, "mission");
        assertUniqueId(
          (working.foundationRecords ?? []).map((entry) => entry.recordId),
          missionId,
          "Mission record",
        );
        record({
          kind: "mission",
          recordId: missionId,
          projectId: command.projectId,
          title: target.title,
          objective: target.objective,
          requiredTaskIds: [],
          status: "draft",
          revision: 0,
          generation: 0,
          updatedAt: command.refinedAt,
        });
        record({
          ...issue,
          missionId,
          revision: issue.revision + 1,
          updatedAt: command.refinedAt,
        });
      } else {
        if (target.kind === "new-task") {
          const created = decideProjectWorkCommand(working, {
            type: "project-work.task.create",
            commandId: command.commandId,
            projectId: command.projectId,
            expectedRevision: working.revision,
            taskId: target.taskId,
            title: target.title,
            ...(target.summary === undefined ? {} : { summary: target.summary }),
            deliverableKind: target.deliverableKind,
            createdAt: command.refinedAt,
            attribution: origin,
          });
          events.push(...created);
          working = applyProjectWorkEvents(working, created);
        } else {
          const task = currentTask(working, target.taskId);
          if (task.projectId !== command.projectId)
            throw new ProjectWorkPolicyError("invalid-state", "Task belongs to another project");
          if (task.revision !== target.expectedTaskRevision)
            throw new ProjectWorkPolicyError("stale-revision", "Task revision is stale");
          if (task.state === "completed" || task.state === "canceled")
            throw new ProjectWorkPolicyError(
              "invalid-state",
              "Completed or canceled tasks cannot be linked by refinement",
            );
        }
        record({
          ...issue,
          taskId: target.taskId,
          revision: issue.revision + 1,
          updatedAt: command.refinedAt,
        });
      }
      return events;
    }
    case "project-work.foundation.commit": {
      if (
        command.transition?.kind === "publication.claim" ||
        command.transition?.kind === "publication.reflect"
      )
        return decideProjectTeamPublicationTransition(mutableState(state), command, event);
      if (command.transition?.kind === "memory.reflect")
        return decideProjectTeamMemoryReflection(
          mutableState(state),
          command,
          event,
          applyProjectWorkEvents,
        );
      if (command.transition !== undefined)
        return decideProjectTeamGuidedTransition(
          mutableState(state),
          command,
          event,
          applyProjectWorkEvents,
        );
      if (command.guided !== undefined)
        return decideProjectTeamGuidedLifecycle(
          mutableState(state),
          command,
          event,
          applyProjectWorkEvents,
        );
      let working = mutableState(state);
      const events: Array<ProjectWorkEvent> = [];
      if (command.claim !== undefined) {
        if (
          command.records.some(
            (r) =>
              (r.kind === "task-membership" &&
                r.taskId === command.claim!.taskId &&
                r.executionKind === "managed") ||
              (r.kind === "run-binding" && r.taskId === command.claim!.taskId),
          )
        )
          throw new ProjectWorkPolicyError(
            "authority-required",
            "Managed claim requires an exact grant transition",
          );
        if (
          command.claim.projectId !== command.projectId ||
          command.claim.commandId !== command.commandId
        )
          throw new ProjectWorkPolicyError(
            "invalid-state",
            "Atomic claim must use the enclosing command identity",
          );
        const claimed = decideProjectWorkCommand(working, command.claim);
        events.push(...claimed);
        working = applyProjectWorkEvents(working, claimed);
      }
      const seen = new Set<string>();
      for (const input of command.records) {
        if (
          (input.kind === "gate" && input.status === "consumed") ||
          (input.kind === "run-binding" &&
            input.status === "settled" &&
            working.foundationRecords?.find((r) => r.recordId === input.recordId)?.status !==
              "settled") ||
          (input.kind === "run-binding" &&
            (input.status === "reserved" || input.status === "running") &&
            !working.foundationRecords?.some((r) => r.recordId === input.recordId))
        )
          throw new ProjectWorkPolicyError(
            "authority-required",
            "Managed grant consumption and run creation require a typed transition",
          );
        if (seen.has(input.recordId))
          throw new ProjectWorkPolicyError(
            "duplicate-record",
            "One foundation transaction cannot write the same record twice",
          );
        seen.add(input.recordId);
        const record = validateProjectTeamRecord(working, input, command.attribution);
        const recorded = event(
          { type: "project-work.foundation.recorded", record, occurredAt: command.committedAt },
          events.length,
        );
        events.push(recorded);
        working = applyProjectWorkEvents(working, [recorded]);
        if (record.kind === "evidence-applicability" && record.status === "current") {
          const moved = (working.foundationRecords ?? []).filter(
            (r) =>
              r.kind === "evidence-applicability" &&
              r.taskId === record.taskId &&
              r.recordId !== record.recordId &&
              r.status === "current" &&
              (r.baseSha !== record.baseSha || r.headSha !== record.headSha),
          );
          if (moved.length > 0) {
            const affected = (working.foundationRecords ?? []).filter(
              (r) =>
                moved.some((old) => old.recordId === r.recordId) ||
                (r.kind === "gate" &&
                  r.taskId === record.taskId &&
                  r.gate === "merge" &&
                  r.status !== "invalidated"),
            );
            for (const old of affected) {
              if (old.kind !== "gate" && old.kind !== "evidence-applicability") continue;
              const changed = validateProjectTeamRecord(
                working,
                {
                  ...(old.kind === "gate"
                    ? { ...old, status: "invalidated" as const }
                    : { ...old, status: "stale" as const }),
                  revision: old.revision + 1,
                  updatedAt: command.committedAt,
                },
                command.attribution,
              );
              const next = event(
                {
                  type: "project-work.foundation.recorded",
                  record: changed,
                  occurredAt: command.committedAt,
                },
                events.length,
              );
              events.push(next);
              working = applyProjectWorkEvents(working, [next]);
            }
          }
        }
      }
      return events;
    }
    case "project-work.task.create": {
      assertUniqueId(
        state.tasks.map((entry) => String(entry.taskId)),
        command.taskId,
        "Task",
      );
      const task: ProjectWorkTask = {
        taskId: command.taskId,
        projectId: state.projectId as ProjectWorkTask["projectId"],
        title: command.title,
        ...(command.summary === undefined ? {} : { summary: command.summary }),
        state: "draft",
        watchers: [],
        revision: 0,
        specRevision: 0,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      const created = event({
        type: "project-work.task.created",
        task,
        occurredAt: command.createdAt,
      });
      if (command.deliverableKind === undefined) return [created];
      if (command.attribution?.actor.kind !== "human")
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Guided deliverable capture requires authenticated human attribution",
        );
      const record = validateProjectTeamRecord(
        applyProjectWorkEvents(state, [created]),
        {
          recordId: projectTeamDerivedRecordId(command.commandId, "membership"),
          kind: "task-membership",
          projectId: command.projectId,
          taskId: task.taskId,
          deliverableKind: command.deliverableKind,
          executionKind: command.deliverableKind === "code" ? "managed" : "human",
          status: "active",
          controlState: "active",
          revision: 0,
          generation: 0,
          updatedAt: command.createdAt,
        },
        command.attribution,
      );
      return [
        created,
        event(
          { type: "project-work.foundation.recorded", record, occurredAt: command.createdAt },
          1,
        ),
      ];
    }
    case "project-work.task.specify": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      assertProtectedSpecificationMutable(task, command.type);
      if (task.state !== "draft" && task.state !== "specified") {
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Task '${task.taskId}' cannot be specified from '${task.state}'.`,
          {
            taskId: task.taskId,
            state: task.state,
          },
        );
      }
      if (command.specification.protected === true) {
        throw new ProjectWorkPolicyError(
          "approval-required",
          "Protected specifications must be established through an approved protection intent.",
          { taskId: task.taskId, specRevision: command.specification.revision },
        );
      }
      if (
        task.specification !== undefined &&
        command.specification.revision <= task.specification.revision
      ) {
        throw new ProjectWorkPolicyError(
          "stale-revision",
          "A specification revision must increase the current revision.",
          {
            taskId: task.taskId,
            currentRevision: task.specification.revision,
            nextRevision: command.specification.revision,
          },
        );
      }
      const criteria = new Set(state.criteria.map((entry) => String(entry.criterionId)));
      assertUniqueValues(command.specification.criterionIds, "Specification criterion IDs", {
        taskId: task.taskId,
      });
      const missing = command.specification.criterionIds.filter((id) => {
        const criterion = state.criteria.find((entry) => entry.criterionId === id);
        return !criteria.has(String(id)) || criterion?.taskId !== task.taskId;
      });
      if (missing.length > 0) {
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          "Every specification criterion must already exist; missing criteria are not allowed.",
          {
            taskId: task.taskId,
            criterionIds: missing,
          },
        );
      }
      return [
        event({
          type: "project-work.task.specified",
          taskId: task.taskId,
          specification: command.specification,
          updatedAt: command.updatedAt,
          occurredAt: command.updatedAt,
        }),
      ];
    }
    case "project-work.task.revise-protected-specification": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.specification?.protected !== true) {
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          `Task '${task.taskId}' does not have a protected specification.`,
          { taskId: task.taskId },
        );
      }
      if (command.specification.revision <= task.specification.revision) {
        throw new ProjectWorkPolicyError(
          "stale-revision",
          "A protected specification revision must increase the current revision.",
          {
            taskId: task.taskId,
            currentRevision: task.specification.revision,
            nextRevision: command.specification.revision,
          },
        );
      }
      if (command.specification.protected !== true) {
        throw new ProjectWorkPolicyError(
          "protected-specification",
          "A protected specification revision must remain protected.",
          { taskId: task.taskId, specRevision: command.specification.revision },
        );
      }
      if (
        command.approval.taskId !== command.taskId ||
        command.approval.specRevision !== command.specification.revision
      ) {
        throw new ProjectWorkPolicyError(
          "approval-required",
          "Protected revision approval must bind to this task and exact new specification revision.",
          { taskId: task.taskId, specRevision: command.specification.revision },
        );
      }
      if (command.attribution === undefined || command.approval.attribution === undefined) {
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Protected revisions require request and approval attribution.",
          { taskId: task.taskId },
        );
      }
      const payloadFingerprint = projectWorkPayloadFingerprint(
        projectWorkProtectedRevisionFingerprintPayload(command),
      );
      if (payloadFingerprint !== command.approval.payloadFingerprint) {
        throw new ProjectWorkPolicyError(
          "approval-required",
          "Protected revision approval does not match the complete revision payload.",
          {
            taskId: task.taskId,
            expectedFingerprint: payloadFingerprint,
            receivedFingerprint: command.approval.payloadFingerprint,
          },
        );
      }
      const criterionIds = new Set(
        state.criteria.map((criterion) => String(criterion.criterionId)),
      );
      assertUniqueValues(command.specification.criterionIds, "Specification criterion IDs", {
        taskId: task.taskId,
      });
      const missingCriteria = command.specification.criterionIds.filter((criterionId) => {
        const criterion = state.criteria.find((entry) => entry.criterionId === criterionId);
        return !criterionIds.has(String(criterionId)) || criterion?.taskId !== task.taskId;
      });
      if (missingCriteria.length > 0) {
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          "Protected revision references missing criteria.",
          { taskId: task.taskId, criterionIds: missingCriteria },
        );
      }
      const expectedCriterionSnapshots = command.specification.criterionIds.map((criterionId) => {
        const criterion = state.criteria.find((entry) => entry.criterionId === criterionId);
        if (criterion === undefined) {
          throw new ProjectWorkPolicyError(
            "unknown-criterion",
            `Criterion '${criterionId}' does not exist.`,
            { taskId: task.taskId, criterionId },
          );
        }
        return criterion;
      });
      if (
        command.criterionSnapshots.length !== expectedCriterionSnapshots.length ||
        command.criterionSnapshots.some(
          (snapshot, index) =>
            canonicalProjectWorkPayload(snapshot) !==
            canonicalProjectWorkPayload(expectedCriterionSnapshots[index]),
        )
      ) {
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          "Protected revision criterion snapshots must match the current criteria.",
          { taskId: task.taskId, criterionIds: command.specification.criterionIds },
        );
      }
      const affectedResultIds = [...new Set(command.affectedResultIds)];
      if (affectedResultIds.length !== command.affectedResultIds.length) {
        throw new ProjectWorkPolicyError(
          "duplicate-record",
          "Protected revision result IDs must be unique.",
          { taskId: task.taskId, resultIds: command.affectedResultIds },
        );
      }
      const candidateTask = taskCopy(task, {
        specification: command.specification,
        specRevision: command.specification.revision,
        state: "specified",
        approval: {
          approvalId: command.approval.approvalId,
          taskId: command.approval.taskId,
          specRevision: command.approval.specRevision,
          approvedAt: command.approval.approvedAt,
          attribution: command.approval.attribution,
        },
      });
      const candidateState: ProjectWorkState = {
        ...state,
        tasks: state.tasks.map((entry) => (entry.taskId === task.taskId ? candidateTask : entry)),
      };
      const nextState = deriveProjectWorkTaskPolicy(candidateState, task.taskId, command.revisedAt)
        .readiness.ready
        ? "ready"
        : "specified";
      const resultInvalidations: ReadonlyArray<ProjectWorkResultInvalidation> =
        affectedResultIds.map((resultId) => ({
          resultId,
          specRevision: command.specification.revision,
          invalidatedAt: command.revisedAt,
        }));
      return [
        event({
          type: "project-work.task.specification-revised",
          taskId: task.taskId,
          specification: command.specification,
          criterionSnapshots: expectedCriterionSnapshots,
          approval: command.approval,
          affectedResultIds,
          resultInvalidations,
          state: nextState,
          revisedAt: command.revisedAt,
          occurredAt: command.revisedAt,
        }),
      ];
    }
    case "project-work.task.ready": {
      assertTaskCanBeReady(state, command.taskId);
      return [
        event({
          type: "project-work.task.ready",
          taskId: command.taskId,
          occurredAt: command.updatedAt,
        }),
      ];
    }
    case "project-work.task.claim": {
      if (isGuidedProjectTeamTask(state, command.taskId))
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Managed tasks require server-created run authority",
        );
      const task = currentTask(state, command.taskId);
      const policy = deriveProjectWorkTaskPolicy(state, command.taskId, command.claimedAt);
      if (!policy.claimability.claimable) {
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Task '${task.taskId}' is not claimable.`,
          {
            taskId: task.taskId,
            reason: policy.claimability.reason,
          },
        );
      }
      assertNoActiveAttempt(state, command.taskId);
      assertUniqueId(
        state.attempts.map((entry) => String(entry.attemptId)),
        command.attemptId,
        "Attempt",
      );
      const attempt: ProjectWorkAttempt = {
        attemptId: command.attemptId,
        taskId: command.taskId,
        state: "leased",
        leaseToken: command.leaseToken,
        leasedUntil: command.leasedUntil,
        checkpointIds: [],
        revision: 0,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      return [
        event({
          type: "project-work.task.claimed",
          taskId: command.taskId,
          attempt,
          occurredAt: command.claimedAt,
        }),
      ];
    }
    case "project-work.task.complete": {
      const task = assertTaskCanBeCompleted(state, command.taskId, command.satisfiedCriterionIds);
      const actorKind = command.attribution?.actor.kind;
      const current = activeAttempt(state, task.taskId);
      if (
        current === undefined ||
        command.attemptId === undefined ||
        current.attemptId !== command.attemptId
      )
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Completion must close the current active attempt.",
          { taskId: task.taskId, attemptId: command.attemptId },
        );
      if (actorKind === "agent" || actorKind === "adapter") {
        if (command.attemptId === undefined || command.leaseToken === undefined)
          throw new ProjectWorkPolicyError(
            "authority-required",
            "Worker completion requires an attempt, lease token, and worker attribution.",
            { taskId: task.taskId },
          );
        assertLease(state, task.taskId, command.attemptId, command.leaseToken, command.completedAt);
      } else if (command.attemptId !== undefined) {
        if (command.leaseToken !== undefined)
          assertLease(
            state,
            task.taskId,
            command.attemptId,
            command.leaseToken,
            command.completedAt,
          );
        else if (actorKind !== "human")
          throw new ProjectWorkPolicyError(
            "authority-required",
            "Tokenless completion requires human attribution.",
            { taskId: task.taskId },
          );
      } else if (actorKind !== "human") {
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Tokenless completion requires human attribution.",
          { taskId: task.taskId },
        );
      }
      return [
        event({
          type: "project-work.task.completed",
          taskId: task.taskId,
          ...(command.attemptId === undefined ? {} : { attemptId: command.attemptId }),
          satisfiedCriterionIds: command.satisfiedCriterionIds,
          completedAt: command.completedAt,
          occurredAt: command.completedAt,
        }),
      ];
    }
    case "project-work.task.block": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.state === "completed") {
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Completed task '${task.taskId}' cannot be blocked.`,
          { taskId: task.taskId },
        );
      }
      assertUniqueId(
        state.blockers.map((entry) => String(entry.blockerId)),
        command.blockerId,
        "Blocker",
      );
      const blocker: ProjectWorkBlocker = {
        blockerId: command.blockerId,
        taskId: command.taskId,
        reason: command.reason,
        resolver: command.resolver,
        referenceIds: command.referenceIds,
        attention: true,
        revision: 0,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      return [
        event({
          type: "project-work.task.blocked",
          taskId: task.taskId,
          blocker,
          blockedAt: command.blockedAt,
          occurredAt: command.blockedAt,
        }),
      ];
    }
    case "project-work.task.resolve-blocker": {
      const task = currentTask(state, command.taskId);
      if (task.blockerId !== command.blockerId)
        throw new ProjectWorkPolicyError(
          "unknown-blocker",
          `Blocker '${command.blockerId}' is not active for task '${task.taskId}'.`,
          { taskId: task.taskId, blockerId: command.blockerId },
        );
      const blocker = assertKnownBlocker(state, command.blockerId);
      if (blocker.resolvedAt !== undefined)
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Blocker '${blocker.blockerId}' is already resolved.`,
          { blockerId: blocker.blockerId },
        );
      return [
        event({
          type: "project-work.task.blocker-resolved",
          taskId: task.taskId,
          blockerId: blocker.blockerId,
          resolvedAt: command.resolvedAt,
          occurredAt: command.resolvedAt,
        }),
      ];
    }
    case "project-work.task.reopen": {
      const task = currentTask(state, command.taskId);
      if (task.state === "canceled")
        throw new ProjectWorkPolicyError("invalid-state", "Canceled tasks cannot be reopened.", {
          taskId: task.taskId,
        });
      if (
        task.state !== "completed" &&
        !(task.state === "failed" && task.failureKind === "recoverable")
      )
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Task '${task.taskId}' is not reopenable.`,
          { taskId: task.taskId, state: task.state },
        );
      const candidate = taskCopy(task, {
        state: "specified",
        completedAt: undefined,
        failureKind: undefined,
        updatedAt: command.reopenedAt,
      });
      const candidateState: ProjectWorkState = {
        ...state,
        tasks: state.tasks.map((entry) => (entry.taskId === task.taskId ? candidate : entry)),
      };
      const nextState: Extract<ProjectWorkTaskState, "specified" | "ready"> =
        deriveProjectWorkTaskPolicy(candidateState, task.taskId, command.reopenedAt).readiness.ready
          ? "ready"
          : "specified";
      return [
        event({
          type: "project-work.task.reopened",
          taskId: task.taskId,
          reopenedAt: command.reopenedAt,
          state: nextState,
          occurredAt: command.reopenedAt,
        }),
      ];
    }
    case "project-work.task.cancel": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.state === "completed") {
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Completed task '${task.taskId}' cannot be canceled.`,
          { taskId: task.taskId },
        );
      }
      return [
        event({
          type: "project-work.task.canceled",
          taskId: task.taskId,
          canceledAt: command.canceledAt,
          occurredAt: command.canceledAt,
        }),
      ];
    }
    case "project-work.task.duplicate": {
      const source = currentTask(state, command.sourceTaskId);
      assertTaskMutable(source, command.type);
      assertUniqueId(
        state.tasks.map((entry) => String(entry.taskId)),
        command.duplicateTaskId,
        "Task",
      );
      const duplicate: ProjectWorkTask = {
        taskId: command.duplicateTaskId,
        projectId: state.projectId as ProjectWorkTask["projectId"],
        title: command.title ?? source.title,
        ...(command.summary === undefined
          ? source.summary === undefined
            ? {}
            : { summary: source.summary }
          : { summary: command.summary }),
        state: "draft",
        watchers: [],
        revision: 0,
        specRevision: 0,
        createdAt: command.duplicatedAt,
        updatedAt: command.duplicatedAt,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      const relationship: ProjectWorkRelationship = {
        relationshipId: ProjectWorkRelationshipId.make(
          `${command.duplicateTaskId}:duplicates:${command.sourceTaskId}`,
        ),
        projectId: state.projectId as ProjectWorkRelationship["projectId"],
        fromTaskId: command.duplicateTaskId,
        toTaskId: command.sourceTaskId,
        kind: "duplicates",
        revision: 0,
        createdAt: command.duplicatedAt,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      return [
        event({
          type: "project-work.task.duplicated",
          sourceTaskId: source.taskId,
          task: duplicate,
          relationship,
          duplicatedAt: command.duplicatedAt,
          occurredAt: command.duplicatedAt,
        }),
      ];
    }
    case "project-work.task.approve": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.specification === undefined || task.specification.revision !== command.specRevision)
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          "Approval must bind to the current specification revision.",
          {
            taskId: task.taskId,
            specRevision: command.specRevision,
            currentRevision: task.specification?.revision,
          },
        );
      if (task.approval?.specRevision === command.specRevision)
        throw new ProjectWorkPolicyError(
          "duplicate-record",
          "Specification revision is already approved.",
          { taskId: task.taskId, specRevision: command.specRevision },
        );
      if (command.attribution === undefined)
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Specification approval requires attribution.",
          { taskId: task.taskId },
        );
      const approval: ProjectWorkApproval = {
        approvalId: command.approvalId,
        taskId: task.taskId,
        specRevision: command.specRevision,
        approvedAt: command.approvedAt,
        attribution: command.attribution,
      };
      return [
        event({
          type: "project-work.task.approved",
          taskId: task.taskId,
          approval,
          approvedAt: command.approvedAt,
          occurredAt: command.approvedAt,
        }),
      ];
    }
    case "project-work.task.assign": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      return [
        event({
          type: "project-work.task.assigned",
          taskId: task.taskId,
          assignee: command.assignee === null ? undefined : command.assignee,
          assignedAt: command.assignedAt,
          occurredAt: command.assignedAt,
        }),
      ];
    }
    case "project-work.task.watch": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (
        (task.watchers ?? []).some(
          (watcher) => projectWorkActorKey(watcher) === projectWorkActorKey(command.watcher),
        )
      )
        throw new ProjectWorkPolicyError(
          "duplicate-record",
          "Actor is already watching this task.",
          { taskId: task.taskId },
        );
      return [
        event({
          type: "project-work.task.watched",
          taskId: task.taskId,
          watcher: command.watcher,
          watchedAt: command.watchedAt,
          occurredAt: command.watchedAt,
        }),
      ];
    }
    case "project-work.task.unwatch": {
      const task = currentTask(state, command.taskId);
      if (
        !(task.watchers ?? []).some(
          (watcher) => projectWorkActorKey(watcher) === projectWorkActorKey(command.watcher),
        )
      )
        throw new ProjectWorkPolicyError("invalid-state", "Actor is not watching this task.", {
          taskId: task.taskId,
        });
      return [
        event({
          type: "project-work.task.unwatched",
          taskId: task.taskId,
          watcher: command.watcher,
          unwatchedAt: command.unwatchedAt,
          occurredAt: command.unwatchedAt,
        }),
      ];
    }
    case "project-work.task.protect-specification": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.specification === undefined)
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          "A task must have a specification before it can be protected.",
          { taskId: task.taskId },
        );
      if (task.specification.revision !== command.specRevision)
        throw new ProjectWorkPolicyError(
          "stale-revision",
          "Protection must bind to the current specification revision.",
          {
            taskId: task.taskId,
            specRevision: command.specRevision,
            currentRevision: task.specification.revision,
          },
        );
      if (task.specification.protected)
        throw new ProjectWorkPolicyError(
          "protected-specification",
          "Specification is already protected.",
          { taskId: task.taskId },
        );
      return [
        event({
          type: "project-work.task.specification-protected",
          taskId: task.taskId,
          specRevision: command.specRevision,
          protectedAt: command.protectedAt,
          occurredAt: command.protectedAt,
        }),
      ];
    }
    case "project-work.criterion.upsert": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (command.criterion.waiver !== undefined) {
        throw new ProjectWorkPolicyError(
          "invalid-specification",
          "Criterion upsert cannot waive a criterion; use the explicit waiver command.",
          { taskId: task.taskId, criterionId: command.criterion.criterionId },
        );
      }
      assertCriterionBelongsToTask(command.criterion, task.taskId);
      if (task.specification?.protected === true)
        throw new ProjectWorkPolicyError(
          "protected-specification",
          "Criteria cannot be mutated after specification protection.",
          { taskId: task.taskId, criterionId: command.criterion.criterionId },
        );
      const existing = state.criteria.find(
        (criterion) => criterion.criterionId === command.criterion.criterionId,
      );
      if (existing !== undefined && existing.taskId !== task.taskId) {
        throw new ProjectWorkPolicyError(
          "duplicate-record",
          `Criterion '${command.criterion.criterionId}' belongs to another task.`,
          { criterionId: command.criterion.criterionId, taskId: task.taskId },
        );
      }
      return [
        event({
          type: "project-work.criterion.upserted",
          taskId: task.taskId,
          criterion:
            existing === undefined
              ? command.criterion
              : {
                  ...command.criterion,
                  revision: existing.revision + 1,
                  updatedAt: command.updatedAt,
                },
          updatedAt: command.updatedAt,
          occurredAt: command.updatedAt,
        }),
      ];
    }
    case "project-work.criterion.waive": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.specification?.protected === true)
        throw new ProjectWorkPolicyError(
          "protected-specification",
          "Criteria cannot be mutated after specification protection.",
          { taskId: task.taskId, criterionId: command.criterionId },
        );
      const criterion = assertKnownCriterion(state, command.criterionId);
      assertCriterionBelongsToTask(criterion, task.taskId);
      return [
        event({
          type: "project-work.criterion.waived",
          taskId: task.taskId,
          criterionId: criterion.criterionId,
          waiver: command.waiver,
          waivedAt: command.waivedAt,
          occurredAt: command.waivedAt,
        }),
      ];
    }
    case "project-work.evidence.add": {
      const evidence = command.evidence;
      assertUniqueId(
        state.evidence.map((entry) => String(entry.evidenceId)),
        evidence.evidenceId,
        "Evidence",
      );
      if (evidence.taskId !== undefined) currentTask(state, evidence.taskId);
      if (evidence.criterionId !== undefined) {
        const criterion = assertKnownCriterion(state, evidence.criterionId);
        if (evidence.taskId !== undefined) assertCriterionBelongsToTask(criterion, evidence.taskId);
      }
      return [
        event({
          type: "project-work.evidence.added",
          evidence,
          addedAt: command.addedAt,
          occurredAt: command.addedAt,
        }),
      ];
    }
    case "project-work.task.fail": {
      const task = currentTask(state, command.taskId);
      assertTaskMutable(task, command.type);
      if (task.state !== "in-progress" && task.state !== "in-review")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          `Task '${task.taskId}' is not running and cannot fail.`,
          { taskId: task.taskId, state: task.state },
        );
      const actorKind = command.attribution?.actor.kind;
      if (
        (actorKind === "agent" || actorKind === "adapter") &&
        (command.attemptId === undefined || command.leaseToken === undefined)
      )
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Worker failures require the current attempt, lease token, and worker attribution.",
          { taskId: task.taskId },
        );
      const attempt =
        actorKind === "agent" || actorKind === "adapter"
          ? assertLease(
              state,
              task.taskId,
              command.attemptId!,
              command.leaseToken!,
              command.failedAt,
            )
          : command.attemptId !== undefined && command.leaseToken !== undefined
            ? assertLease(
                state,
                task.taskId,
                command.attemptId,
                command.leaseToken,
                command.failedAt,
              )
            : activeAttempt(state, task.taskId);
      if (attempt === undefined)
        throw new ProjectWorkPolicyError("invalid-state", "No active attempt can be failed.", {
          taskId: task.taskId,
        });
      if (actorKind !== "human" && actorKind !== "agent" && actorKind !== "adapter")
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Task failures require human or worker attribution.",
          { taskId: task.taskId },
        );
      if (actorKind === "human" && command.attemptId !== undefined) {
        if (attempt?.attemptId !== command.attemptId)
          throw new ProjectWorkPolicyError(
            "invalid-state",
            "A tokenless human failure must close the current active attempt.",
            { taskId: task.taskId, attemptId: command.attemptId },
          );
      }
      if (command.failureKind === "manual-triage" && command.attribution?.actor.kind !== "human")
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Manual-triage failures require human attribution.",
          { taskId: task.taskId },
        );
      return [
        event({
          type: "project-work.task.failed",
          taskId: task.taskId,
          ...(attempt === undefined ? {} : { attemptId: attempt.attemptId }),
          failureKind: command.failureKind,
          reason: command.reason,
          evidenceIds: command.evidenceIds ?? [],
          failedAt: command.failedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.failedAt,
        }),
      ];
    }
    case "project-work.task.resolve-failure": {
      const task = currentTask(state, command.taskId);
      if (task.state !== "failed")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Only failed tasks can resolve failure.",
          {
            taskId: task.taskId,
          },
        );
      if (command.attribution.actor.kind !== "human")
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Failure resolution requires human attribution.",
          {
            taskId: task.taskId,
          },
        );
      const failedAttempt = [...state.attempts]
        .reverse()
        .find(
          (attempt) =>
            attempt.taskId === task.taskId &&
            (attempt.state === "failed" || attempt.state === "expired") &&
            attempt.failureResolvedAt === undefined,
        );
      const candidate = taskCopy(task, {
        state: "specified",
        failureKind: undefined,
        activeAttemptId: undefined,
        updatedAt: command.resolvedAt,
      });
      const candidateState: ProjectWorkState = {
        ...state,
        tasks: state.tasks.map((entry) => (entry.taskId === task.taskId ? candidate : entry)),
      };
      const nextState = stateForReadiness(
        candidateState as ProjectWorkReducerState,
        task.taskId,
        command.resolvedAt,
      );
      return [
        event({
          type: "project-work.task.failure-resolved",
          taskId: task.taskId,
          ...(failedAttempt === undefined ? {} : { failedAttemptId: failedAttempt.attemptId }),
          reason: command.reason,
          evidenceIds: command.evidenceIds,
          resolvedAt: command.resolvedAt,
          state: nextState,
          attribution: command.attribution,
          occurredAt: command.resolvedAt,
        }),
      ];
    }
    case "project-work.attempt.renew": {
      const attempt = assertLease(
        state,
        command.taskId,
        command.attemptId,
        command.leaseToken,
        command.renewedAt,
      );
      return [
        event({
          type: "project-work.attempt.renewed",
          taskId: command.taskId,
          attemptId: attempt.attemptId,
          leaseToken: command.leaseToken,
          leasedUntil: command.leasedUntil,
          renewedAt: command.renewedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.renewedAt,
        }),
      ];
    }
    case "project-work.attempt.checkpoint": {
      const attempt = assertLease(
        state,
        command.taskId,
        command.attemptId,
        command.leaseToken,
        command.capturedAt,
      );
      if (state.attempts.some((entry) => entry.checkpointIds.includes(command.checkpointId)))
        throw new ProjectWorkPolicyError(
          "duplicate-record",
          `Checkpoint '${command.checkpointId}' already exists.`,
          {
            checkpointId: command.checkpointId,
          },
        );
      const checkpoint: ProjectWorkCheckpoint = {
        checkpointId: command.checkpointId,
        projectId: state.projectId,
        taskId: command.taskId,
        attemptId: attempt.attemptId,
        ...(command.ref === undefined ? {} : { ref: command.ref }),
        capturedAt: command.capturedAt,
        revision: attempt.revision + 1,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      return [
        event({
          type: "project-work.attempt.checkpointed",
          checkpoint,
          occurredAt: command.capturedAt,
        }),
      ];
    }
    case "project-work.attempt.expire": {
      const attempt = state.attempts.find((entry) => entry.attemptId === command.attemptId);
      if (attempt === undefined || attempt.taskId !== command.taskId)
        throw new ProjectWorkPolicyError("invalid-state", "Attempt does not belong to this task.", {
          attemptId: command.attemptId,
        });
      if (attempt.state !== "leased" && attempt.state !== "running")
        throw new ProjectWorkPolicyError("invalid-state", "Only active attempts can expire.", {
          attemptId: command.attemptId,
        });
      if (!leaseExpired(attempt, command.expiredAt))
        throw new ProjectWorkPolicyError("invalid-state", "The attempt lease has not expired.", {
          attemptId: command.attemptId,
        });
      const expiredEvents = [
        event({
          type: "project-work.attempt.expired",
          taskId: command.taskId,
          attemptId: attempt.attemptId,
          reason: command.reason,
          expiredAt: command.expiredAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.expiredAt,
        }),
      ];
      if (isGuidedProjectTeamTask(state, command.taskId)) {
        let working = applyProjectWorkEvents(state, expiredEvents);
        const at = command.expiredAt;
        const origin = command.attribution ?? {
          actor: { kind: "system" as const, id: "project-work-lease" },
          source: { kind: "system" as const, id: "project-work-lease" },
          recordedAt: at,
        };
        for (const run of state.foundationRecords ?? []) {
          if (
            run.kind !== "run-binding" ||
            run.taskId !== command.taskId ||
            run.attemptId !== command.attemptId ||
            run.status === "settled"
          )
            continue;
          const append = (input: ProjectTeamRecord) => {
            const record = validateProjectTeamRecord(working, input, origin);
            const next = event(
              { type: "project-work.foundation.recorded", record, occurredAt: at },
              expiredEvents.length,
            );
            expiredEvents.push(next);
            working = applyProjectWorkEvents(working, [next]);
          };
          append({ ...run, status: "quarantined", revision: run.revision + 1, updatedAt: at });
          append({
            recordId: projectTeamDerivedRecordId(command.commandId, `lease-stop:${run.recordId}`),
            projectId: command.projectId,
            kind: "effect",
            status: "pending",
            revision: 0,
            generation: 0,
            updatedAt: at,
            effectId: projectTeamDerivedRecordId(command.commandId, `lease-stop:${run.recordId}`),
            effectKind: "stop",
            taskId: run.taskId,
            runId: run.recordId,
            targetId: run.recordId,
            payload: {
              recordIds: [run.recordId],
              expectedRevision: run.revision,
              summary: command.reason,
            },
            claimGeneration: run.generation,
            availableAt: at,
          });
        }
      }
      return expiredEvents;
    }
    case "project-work.attempt.reclaim": {
      const task = currentTask(state, command.taskId);
      const previous = state.attempts.find(
        (entry) => entry.attemptId === command.previousAttemptId,
      );
      if (previous === undefined || previous.taskId !== task.taskId)
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Reclaim predecessor does not belong to this task.",
          {
            attemptId: command.previousAttemptId,
          },
        );
      if (previous.state !== "failed" && previous.state !== "expired")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Only failed or expired attempts can be reclaimed.",
          {
            attemptId: previous.attemptId,
          },
        );
      if (previous.failureKind === "manual-triage" || task.failureKind === "manual-triage")
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Manual-triage failures require resolution before reclaim.",
          {
            taskId: task.taskId,
          },
        );
      assertNoActiveAttempt(state, task.taskId);
      const policy = deriveProjectWorkTaskPolicy(state, task.taskId, command.claimedAt);
      if (!policy.claimability.claimable)
        throw new ProjectWorkPolicyError("invalid-state", "Task is not currently reclaimable.", {
          taskId: task.taskId,
          reason: policy.claimability.reason,
        });
      assertUniqueId(
        state.attempts.map((entry) => String(entry.attemptId)),
        command.attemptId,
        "Attempt",
      );
      const attempt: ProjectWorkAttempt = {
        attemptId: command.attemptId,
        taskId: task.taskId,
        state: "leased",
        leaseToken: command.leaseToken,
        leasedUntil: command.leasedUntil,
        checkpointIds: [],
        revision: 0,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      return [
        event({
          type: "project-work.attempt.reclaimed",
          taskId: task.taskId,
          previousAttemptId: previous.attemptId,
          attempt,
          reclaimedAt: command.claimedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.claimedAt,
        }),
      ];
    }
    case "project-work.attempt.takeover": {
      if (!command.authorized)
        throw new ProjectWorkPolicyError(
          "authority-required",
          "Taking over an attempt requires authorization.",
          {
            taskId: command.taskId,
          },
        );
      const task = currentTask(state, command.taskId);
      const previous = state.attempts.find(
        (entry) => entry.attemptId === command.previousAttemptId,
      );
      if (
        previous === undefined ||
        previous.taskId !== task.taskId ||
        (previous.state !== "leased" && previous.state !== "running")
      )
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Only the current active attempt can be taken over.",
          {
            attemptId: command.previousAttemptId,
          },
        );
      assertUniqueId(
        state.attempts.map((entry) => String(entry.attemptId)),
        command.attemptId,
        "Attempt",
      );
      const attempt: ProjectWorkAttempt = {
        attemptId: command.attemptId,
        taskId: task.taskId,
        state: "leased",
        leaseToken: command.leaseToken,
        leasedUntil: command.leasedUntil,
        checkpointIds: [],
        revision: 0,
        ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
      };
      return [
        event({
          type: "project-work.attempt.taken-over",
          taskId: task.taskId,
          previousAttemptId: previous.attemptId,
          attempt,
          takeoverAt: command.claimedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.claimedAt,
        }),
      ];
    }
    case "project-work.knowledge.promote": {
      const knowledge =
        command.knowledge.attribution === undefined && command.attribution !== undefined
          ? { ...command.knowledge, attribution: command.attribution }
          : command.knowledge;
      if (knowledge.projectId !== state.projectId)
        throw new ProjectWorkPolicyError("invalid-state", "Knowledge belongs to another project.", {
          knowledgeId: knowledge.knowledgeId,
        });
      assertUniqueId(
        stateForRecords(state, "knowledge").map((entry) => String(entry.knowledgeId)),
        String(knowledge.knowledgeId),
        "Knowledge",
      );
      return [
        event({
          type: "project-work.knowledge.promoted",
          knowledge,
          promotedAt: command.promotedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.promotedAt,
        }),
      ];
    }
    case "project-work.decision.propose": {
      const decision =
        command.decision.attribution === undefined && command.attribution !== undefined
          ? { ...command.decision, attribution: command.attribution }
          : command.decision;
      if (decision.projectId !== state.projectId)
        throw new ProjectWorkPolicyError("invalid-state", "Decision belongs to another project.", {
          decisionId: decision.decisionId,
        });
      assertUniqueId(
        stateForRecords(state, "decisions").map((entry) => String(entry.decisionId)),
        String(decision.decisionId),
        "Decision",
      );
      if (decision.state !== "proposed")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "A proposed decision must start proposed.",
        );
      return [
        event({
          type: "project-work.decision.proposed",
          decision,
          proposedAt: command.proposedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.proposedAt,
        }),
      ];
    }
    case "project-work.decision.accept": {
      const decision = stateForRecords(state, "decisions").find(
        (entry) => entry.decisionId === command.decisionId,
      );
      if (decision === undefined || decision.state !== "proposed")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Only proposed decisions can be accepted.",
          {
            decisionId: command.decisionId,
          },
        );
      return [
        event({
          type: "project-work.decision.accepted",
          decisionId: command.decisionId,
          acceptedAt: command.acceptedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.acceptedAt,
        }),
      ];
    }
    case "project-work.decision.reject": {
      const decision = stateForRecords(state, "decisions").find(
        (entry) => entry.decisionId === command.decisionId,
      );
      if (decision === undefined || decision.state !== "proposed")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Only proposed decisions can be rejected.",
          {
            decisionId: command.decisionId,
          },
        );
      return [
        event({
          type: "project-work.decision.rejected",
          decisionId: command.decisionId,
          reason: command.reason,
          rejectedAt: command.rejectedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.rejectedAt,
        }),
      ];
    }
    case "project-work.decision.supersede": {
      if (command.attribution === undefined)
        throw new ProjectWorkPolicyError(
          "deferred-command",
          "Command 'project-work.decision.supersede' requires attribution.",
          { commandType: command.type },
        );
      const decision = stateForRecords(state, "decisions").find(
        (entry) => entry.decisionId === command.decisionId,
      );
      if (decision === undefined || decision.state !== "accepted")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "Only accepted decisions can be superseded.",
          {
            decisionId: command.decisionId,
          },
        );
      if (
        command.replacement.supersedesDecisionId !== undefined &&
        command.replacement.supersedesDecisionId !== command.decisionId
      )
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "A replacement decision must supersede the decision named by the command.",
          { decisionId: command.decisionId },
        );
      const replacement = {
        ...command.replacement,
        supersedesDecisionId: command.decisionId,
        ...(command.replacement.attribution === undefined
          ? { attribution: command.attribution }
          : {}),
      };
      if (replacement.projectId !== state.projectId || replacement.state !== "proposed")
        throw new ProjectWorkPolicyError(
          "invalid-state",
          "A superseding decision must be a proposed decision in this project.",
        );
      assertUniqueId(
        stateForRecords(state, "decisions").map((entry) => String(entry.decisionId)),
        String(replacement.decisionId),
        "Decision",
      );
      return [
        event({
          type: "project-work.decision.superseded",
          decisionId: command.decisionId,
          replacement,
          supersededAt: command.supersededAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.supersededAt,
        }),
      ];
    }
    case "project-work.comment.add": {
      const comment =
        command.comment.attribution === undefined && command.attribution !== undefined
          ? { ...command.comment, attribution: command.attribution }
          : command.comment;
      if (comment.projectId !== state.projectId)
        throw new ProjectWorkPolicyError("invalid-state", "Comment belongs to another project.");
      if (stateForRecords(state, "comments").some((entry) => entry.commentId === comment.commentId))
        throw new ProjectWorkPolicyError("duplicate-record", "Comment already exists.", {
          commentId: comment.commentId,
        });
      if (comment.taskId !== undefined) currentTask(state, comment.taskId);
      return [
        event({
          type: "project-work.comment.added",
          comment,
          addedAt: command.addedAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.addedAt,
        }),
      ];
    }
    case "project-work.attention.seen": {
      currentTask(state, command.taskId);
      return [
        event({
          type: "project-work.attention.seen",
          taskId: command.taskId,
          seenAt: command.seenAt,
          ...(command.attribution === undefined ? {} : { attribution: command.attribution }),
          occurredAt: command.seenAt,
        }),
      ];
    }
    case "project-work.relationship.link": {
      assertRelationshipTasks(state, command.relationship);
      return [
        event({
          type: "project-work.relationship.linked",
          relationship: command.relationship,
          linkedAt: command.linkedAt,
          occurredAt: command.linkedAt,
        }),
      ];
    }
    case "project-work.relationship.unlink": {
      const relationship = state.relationships.find(
        (entry) => entry.relationshipId === command.relationshipId,
      );
      if (relationship === undefined)
        throw new ProjectWorkPolicyError(
          "unknown-relationship",
          `Relationship '${command.relationshipId}' does not exist.`,
          { relationshipId: command.relationshipId },
        );
      return [
        event({
          type: "project-work.relationship.unlinked",
          relationshipId: relationship.relationshipId,
          unlinkedAt: command.unlinkedAt,
          occurredAt: command.unlinkedAt,
        }),
      ];
    }
    default: {
      throw new ProjectWorkPolicyError(
        "deferred-command",
        "The project-work command is not supported by this decider.",
      );
    }
  }
}

const updateTask = (
  state: ProjectWorkReducerState,
  taskId: ProjectWorkTaskId,
  patch: { [Key in keyof ProjectWorkTask]?: ProjectWorkTask[Key] | undefined },
): void => {
  const index = state.tasks.findIndex((task) => task.taskId === taskId);
  if (index >= 0) state.tasks[index] = taskCopy(state.tasks[index]!, patch);
};

const mutableState = (state: ProjectWorkState): ProjectWorkReducerState => ({
  ...state,
  tasks: state.tasks.map((task) => ({
    ...task,
    ...(task.specification === undefined
      ? {}
      : {
          specification: {
            ...task.specification,
            criterionIds: [...task.specification.criterionIds],
          },
        }),
    ...(task.watchers === undefined
      ? {}
      : { watchers: task.watchers.map((watcher) => ({ ...watcher })) }),
    ...(task.assignee === undefined ? {} : { assignee: { ...task.assignee } }),
    ...(task.approval === undefined
      ? {}
      : {
          approval: {
            ...task.approval,
            attribution: {
              ...task.approval.attribution,
              actor: { ...task.approval.attribution.actor },
              source: { ...task.approval.attribution.source },
            },
          },
        }),
  })),
  attempts: state.attempts.map((attempt) => ({
    ...attempt,
    checkpointIds: [...attempt.checkpointIds],
  })),
  criteria: state.criteria.map((criterion) => ({
    ...criterion,
    satisfiedByEvidenceIds: [...criterion.satisfiedByEvidenceIds],
    ...(criterion.waiver === undefined
      ? {}
      : {
          waiver: {
            ...criterion.waiver,
            evidenceIds: [...criterion.waiver.evidenceIds],
            attribution: {
              ...criterion.waiver.attribution,
              actor: { ...criterion.waiver.attribution.actor },
              source: { ...criterion.waiver.attribution.source },
            },
          },
        }),
  })),
  evidence: state.evidence.map((evidence) => ({ ...evidence })),
  relationships: state.relationships.map((relationship) => ({ ...relationship })),
  blockers: state.blockers.map((blocker) => ({
    ...blocker,
    referenceIds: [...blocker.referenceIds],
  })),
  foundationRecords: [...((state as ProjectWorkReducerState).foundationRecords ?? [])],
  attention: [...state.attention],
  history: [...((state as ProjectWorkReducerState).history ?? [])],
  resultInvalidations: [...((state as ProjectWorkReducerState).resultInvalidations ?? [])],
  checkpoints: [...((state as ProjectWorkReducerState).checkpoints ?? [])].map((checkpoint) => ({
    ...checkpoint,
  })),
  activities: [...((state as ProjectWorkReducerState).activities ?? [])].map((activity) => ({
    ...activity,
  })),
  knowledge: [...((state as ProjectWorkReducerState).knowledge ?? [])].map((entry) => ({
    ...entry,
  })),
  decisions: [...((state as ProjectWorkReducerState).decisions ?? [])].map((entry) => ({
    ...entry,
  })),
  comments: [...((state as ProjectWorkReducerState).comments ?? [])].map((entry) => ({
    ...entry,
  })),
});

const reconcileTaskAttention = (
  state: ProjectWorkReducerState,
  taskId: ProjectWorkTaskId,
  occurredAt: string,
): void => {
  const task = state.tasks.find((entry) => entry.taskId === taskId);
  if (task === undefined) return;
  const desired = deriveProjectWorkTaskPolicy(state, taskId, occurredAt).attention[0];
  const active = state.attention.find(
    (entry) => entry.taskId === taskId && entry.resolvedAt === undefined,
  );
  const previousRevision = state.attention.reduce(
    (revision, entry) => (entry.taskId === taskId ? Math.max(revision, entry.revision) : revision),
    -1,
  );
  if (
    desired !== undefined &&
    active !== undefined &&
    active.reason === desired.reason &&
    active.detail === desired.detail
  ) {
    state.attention = state.attention.map((entry) =>
      entry === active ? { ...entry, revision: Math.max(entry.revision, desired.revision) } : entry,
    );
    return;
  }
  if (active !== undefined) {
    state.attention = state.attention.map((entry) =>
      entry === active ? { ...entry, resolvedAt: occurredAt, revision: entry.revision + 1 } : entry,
    );
  }
  if (desired !== undefined) {
    // One projection row per task; reopening or changing the reason starts a
    // new publication occurrence even when no task revision changed.
    state.attention = state.attention.filter((entry) => entry.taskId !== taskId);
    const next: ProjectWorkAttention = {
      ...desired,
      revision: Math.max(desired.revision, previousRevision + 1),
    };
    state.attention.push(next);
  }
};

const foundationAttentionTaskIds = (
  state: ProjectWorkReducerState,
  record: ProjectTeamRecord,
): ReadonlySet<ProjectWorkTaskId> => {
  const taskIds = new Set<ProjectWorkTaskId>();
  const missionIds = new Set<string>();
  const records = state.foundationRecords ?? [];
  const collect = (entry: ProjectTeamRecord) => {
    if (entry.projectId !== state.projectId) return;
    if (entry.kind === "issue") {
      if (entry.taskId !== undefined) taskIds.add(entry.taskId);
      if (entry.missionId !== undefined) missionIds.add(entry.missionId);
    } else if (entry.kind === "mission") {
      missionIds.add(entry.recordId);
      for (const taskId of entry.requiredTaskIds) taskIds.add(taskId);
    } else if (entry.kind === "task-membership") taskIds.add(entry.taskId);
    else if (
      entry.kind === "effect" &&
      entry.effectKind === "publication" &&
      entry.taskId !== undefined
    )
      taskIds.add(entry.taskId);
  };
  // Capture old edges before replacing the record, including detached/rebound
  // issue links and tasks removed from a mission.
  collect(record);
  const old = records.find((entry) => entry.recordId === record.recordId);
  if (old !== undefined) collect(old);
  if (missionIds.size > 0)
    for (const entry of records) {
      if (entry.projectId !== state.projectId) continue;
      if (entry.kind === "mission" && missionIds.has(entry.recordId))
        for (const taskId of entry.requiredTaskIds) taskIds.add(taskId);
      if (
        entry.kind === "task-membership" &&
        entry.status === "active" &&
        entry.missionId !== undefined &&
        missionIds.has(entry.missionId)
      )
        taskIds.add(entry.taskId);
    }
  if (taskIds.size === 0) return taskIds;
  const localTaskIds = new Set(
    state.tasks.filter((task) => task.projectId === state.projectId).map((task) => task.taskId),
  );
  return new Set([...taskIds].filter((taskId) => localTaskIds.has(taskId)));
};

const stateForReadiness = (
  state: ProjectWorkReducerState,
  taskId: ProjectWorkTaskId,
  now: string,
): Extract<ProjectWorkTaskState, "specified" | "ready"> => {
  const policy = deriveProjectWorkTaskPolicy(state, taskId, now);
  return policy.readiness.ready ? "ready" : "specified";
};

const appendActivity = (
  state: ProjectWorkReducerState,
  event: ProjectWorkEvent,
  fields?: Partial<
    Pick<
      ProjectWorkActivity,
      "taskId" | "attemptId" | "kind" | "summary" | "detail" | "attribution"
    >
  >,
): void => {
  const activityId = String(event.eventId);
  if ((state.activities ?? []).some((activity) => activity.activityId === activityId)) return;
  const attribution =
    fields?.attribution ??
    ("attribution" in event
      ? event.attribution
      : event.type === "project-work.task.created" || event.type === "project-work.task.duplicated"
        ? event.task.attribution
        : event.type === "project-work.task.claimed"
          ? event.attempt.attribution
          : event.type === "project-work.attempt.checkpointed"
            ? event.checkpoint.attribution
            : undefined);
  state.activities?.push({
    activityId,
    projectId: event.projectId,
    kind: fields?.kind ?? event.type,
    summary: fields?.summary ?? event.type,
    occurredAt: event.occurredAt,
    revision: event.revision,
    ...(fields?.taskId === undefined ? {} : { taskId: fields.taskId }),
    ...(fields?.attemptId === undefined ? {} : { attemptId: fields.attemptId }),
    ...(fields?.detail === undefined ? {} : { detail: fields.detail }),
    ...(attribution === undefined ? {} : { attribution }),
  });
};

/** Applies project-work events to a new state and never mutates its input. */
export function applyProjectWorkEvents(
  state: ProjectWorkState,
  events: ReadonlyArray<ProjectWorkEvent>,
): ProjectWorkReducerState {
  const next = mutableState(state);
  for (const event of events) {
    if ((next.history ?? []).some((entry) => entry.eventId === event.eventId)) continue;
    next.revision = Math.max(next.revision, event.revision);
    next.history = [
      ...(next.history ?? []),
      {
        eventId: event.eventId,
        type: event.type,
        revision: event.revision,
        occurredAt: event.occurredAt,
      },
    ];
    switch (event.type) {
      case "project-work.foundation.recorded": {
        const taskIds = foundationAttentionTaskIds(next, event.record);
        next.foundationRecords = [
          ...(next.foundationRecords ?? []).filter(
            (entry) => entry.recordId !== event.record.recordId,
          ),
          event.record,
        ];
        for (const taskId of taskIds) reconcileTaskAttention(next, taskId, event.occurredAt);
        break;
      }
      case "project-work.task.created":
        next.tasks.push(event.task);
        break;
      case "project-work.task.specified": {
        const task = currentTask(next, event.taskId);
        const changedRevision = task.specRevision !== event.specification.revision;
        updateTask(next, event.taskId, {
          specification: event.specification,
          specRevision: event.specification.revision,
          state: "specified",
          approval: changedRevision ? undefined : task.approval,
          revision: task.revision + 1,
          updatedAt: event.updatedAt,
        });
        break;
      }
      case "project-work.task.specification-revised": {
        const task = currentTask(next, event.taskId);
        const approval: ProjectWorkApproval = {
          approvalId: event.approval.approvalId,
          taskId: event.approval.taskId,
          specRevision: event.approval.specRevision,
          approvedAt: event.approval.approvedAt,
          attribution: event.approval.attribution,
        };
        updateTask(next, event.taskId, {
          specification: event.specification,
          specRevision: event.specification.revision,
          approval,
          state: event.state,
          revision: task.revision + 1,
          updatedAt: event.revisedAt,
        });
        for (const invalidation of event.resultInvalidations) {
          next.resultInvalidations?.push({ ...invalidation });
        }
        break;
      }
      case "project-work.task.ready":
        updateTask(next, event.taskId, {
          state: "ready",
          revision: currentTask(next, event.taskId).revision + 1,
          updatedAt: event.occurredAt,
        });
        break;
      case "project-work.task.claimed":
        next.attempts.push(event.attempt);
        updateTask(next, event.taskId, {
          state: "in-progress",
          activeAttemptId: event.attempt.attemptId,
          revision: currentTask(next, event.taskId).revision + 1,
          updatedAt: event.occurredAt,
        });
        break;
      case "project-work.task.completed": {
        const task = currentTask(next, event.taskId);
        next.criteria = next.criteria.map((criterion) =>
          criterion.taskId === event.taskId &&
          event.satisfiedCriterionIds.includes(criterion.criterionId)
            ? {
                ...criterion,
                status: "satisfied",
                revision: criterion.revision + 1,
                updatedAt: event.completedAt,
              }
            : criterion,
        );
        next.attempts = next.attempts.map((attempt) =>
          event.attemptId === attempt.attemptId ||
          (event.attemptId === undefined && attempt.attemptId === task.activeAttemptId)
            ? {
                ...attempt,
                state: "succeeded",
                endedAt: event.completedAt,
                revision: attempt.revision + 1,
              }
            : attempt,
        ) as Array<ProjectWorkAttempt>;
        updateTask(next, event.taskId, {
          state: "completed",
          completedAt: event.completedAt,
          activeAttemptId: undefined,
          revision: task.revision + 1,
          updatedAt: event.completedAt,
        });
        break;
      }
      case "project-work.task.failed": {
        const task = currentTask(next, event.taskId);
        const targetAttempt =
          event.attemptId === undefined
            ? activeAttempt(next, event.taskId)
            : next.attempts.find((attempt) => attempt.attemptId === event.attemptId);
        next.attempts = next.attempts.map((attempt) =>
          targetAttempt?.attemptId === attempt.attemptId
            ? {
                ...attempt,
                state: "failed",
                failureKind: event.failureKind,
                failureReason: event.reason,
                failureEvidenceIds: [...event.evidenceIds],
                endedAt: event.failedAt,
                revision: attempt.revision + 1,
                ...(event.attribution === undefined ? {} : { attribution: event.attribution }),
              }
            : attempt,
        ) as Array<ProjectWorkAttempt>;
        updateTask(next, event.taskId, {
          state: "failed",
          failureKind: event.failureKind,
          activeAttemptId: undefined,
          updatedAt: event.failedAt,
          revision: task.revision + 1,
        });
        appendActivity(next, event, {
          taskId: event.taskId,
          ...(targetAttempt === undefined ? {} : { attemptId: targetAttempt.attemptId }),
          kind: "task.failed",
          summary: event.reason,
        });
        break;
      }
      case "project-work.task.failure-resolved": {
        const task = currentTask(next, event.taskId);
        if (event.failedAttemptId !== undefined) {
          next.attempts = next.attempts.map((attempt) =>
            attempt.attemptId === event.failedAttemptId &&
            (attempt.state === "failed" || attempt.state === "expired")
              ? {
                  ...attempt,
                  failureResolvedAt: event.resolvedAt,
                  failureResolutionReason: event.reason,
                  failureResolutionEvidenceIds: [...event.evidenceIds],
                  failureResolutionAttribution: event.attribution,
                  endedAt: attempt.endedAt ?? event.resolvedAt,
                  revision: attempt.revision + 1,
                }
              : attempt,
          ) as Array<ProjectWorkAttempt>;
        }
        updateTask(next, event.taskId, {
          state: event.state,
          failureKind: undefined,
          activeAttemptId: undefined,
          updatedAt: event.resolvedAt,
          revision: task.revision + 1,
        });
        appendActivity(next, event, {
          taskId: event.taskId,
          kind: "task.failure-resolved",
          summary: event.reason,
        });
        break;
      }
      case "project-work.attempt.renewed": {
        next.attempts = next.attempts.map((attempt) =>
          attempt.attemptId === event.attemptId &&
          attempt.taskId === event.taskId &&
          (attempt.state === "leased" || attempt.state === "running") &&
          attempt.leaseToken === event.leaseToken
            ? {
                ...attempt,
                state: "running",
                startedAt: attempt.startedAt ?? event.renewedAt,
                leasedUntil: event.leasedUntil,
                revision: attempt.revision + 1,
              }
            : attempt,
        );
        appendActivity(next, event, {
          taskId: event.taskId,
          attemptId: event.attemptId,
          kind: "attempt.renewed",
          summary: "Lease renewed",
        });
        break;
      }
      case "project-work.attempt.checkpointed": {
        const checkpoint = event.checkpoint;
        if (!next.checkpoints?.some((entry) => entry.checkpointId === checkpoint.checkpointId))
          next.checkpoints?.push({ ...checkpoint });
        next.attempts = next.attempts.map((attempt) =>
          attempt.attemptId === checkpoint.attemptId &&
          !attempt.checkpointIds.includes(checkpoint.checkpointId)
            ? {
                ...attempt,
                checkpointIds: [...attempt.checkpointIds, checkpoint.checkpointId],
                revision: attempt.revision + 1,
              }
            : attempt,
        );
        appendActivity(next, event, {
          taskId: checkpoint.taskId,
          attemptId: checkpoint.attemptId,
          kind: "attempt.checkpointed",
          summary: checkpoint.checkpointId,
        });
        break;
      }
      case "project-work.attempt.stopped": {
        next.attempts = next.attempts.map((attempt) =>
          attempt.attemptId === event.attemptId &&
          (attempt.state === "leased" || attempt.state === "running")
            ? {
                ...attempt,
                state: "canceled",
                endedAt: event.stoppedAt,
                revision: attempt.revision + 1,
              }
            : attempt,
        );
        const task = currentTask(next, event.taskId);
        if (task.activeAttemptId === event.attemptId)
          updateTask(next, event.taskId, {
            state: task.state === "in-progress" ? "ready" : task.state,
            activeAttemptId: undefined,
            updatedAt: event.stoppedAt,
            revision: task.revision + 1,
          });
        break;
      }
      case "project-work.attempt.expired": {
        next.attempts = next.attempts.map((attempt) =>
          attempt.attemptId === event.attemptId &&
          (attempt.state === "leased" || attempt.state === "running")
            ? {
                ...attempt,
                state: "expired",
                failureKind: "lease-expired",
                failureReason: event.reason,
                endedAt: event.expiredAt,
                revision: attempt.revision + 1,
              }
            : attempt,
        );
        const task = currentTask(next, event.taskId);
        updateTask(next, event.taskId, {
          state: "failed",
          failureKind: "lease-expired",
          activeAttemptId: undefined,
          updatedAt: event.expiredAt,
          revision: task.revision + 1,
        });
        appendActivity(next, event, {
          taskId: event.taskId,
          attemptId: event.attemptId,
          kind: "attempt.expired",
          summary: event.reason,
        });
        break;
      }
      case "project-work.attempt.reclaimed":
        next.attempts.push({ ...event.attempt, checkpointIds: [...event.attempt.checkpointIds] });
        updateTask(next, event.taskId, {
          state: "in-progress",
          activeAttemptId: event.attempt.attemptId,
          failureKind: undefined,
          updatedAt: event.reclaimedAt,
          revision: currentTask(next, event.taskId).revision + 1,
        });
        appendActivity(next, event, {
          taskId: event.taskId,
          attemptId: event.attempt.attemptId,
          kind: "attempt.reclaimed",
          summary: "Attempt reclaimed",
        });
        break;
      case "project-work.attempt.taken-over":
        next.attempts = next.attempts.map((attempt) =>
          attempt.attemptId === event.previousAttemptId &&
          (attempt.state === "leased" || attempt.state === "running")
            ? {
                ...attempt,
                state: "canceled",
                endedAt: event.takeoverAt,
                revision: attempt.revision + 1,
              }
            : attempt,
        );
        next.attempts.push({ ...event.attempt, checkpointIds: [...event.attempt.checkpointIds] });
        updateTask(next, event.taskId, {
          state: "in-progress",
          activeAttemptId: event.attempt.attemptId,
          failureKind: undefined,
          updatedAt: event.takeoverAt,
          revision: currentTask(next, event.taskId).revision + 1,
        });
        appendActivity(next, event, {
          taskId: event.taskId,
          attemptId: event.attempt.attemptId,
          kind: "attempt.taken-over",
          summary: "Attempt taken over",
        });
        break;
      case "project-work.activity.recorded":
        if (!next.activities?.some((activity) => activity.activityId === event.activity.activityId))
          next.activities?.push({ ...event.activity });
        break;
      case "project-work.knowledge.promoted":
        if (!next.knowledge?.some((entry) => entry.knowledgeId === event.knowledge.knowledgeId))
          next.knowledge?.push({ ...event.knowledge });
        appendActivity(next, event, { kind: "knowledge.promoted", summary: event.knowledge.title });
        break;
      case "project-work.decision.proposed":
        if (!next.decisions?.some((entry) => entry.decisionId === event.decision.decisionId))
          next.decisions?.push({ ...event.decision });
        appendActivity(next, event, { kind: "decision.proposed", summary: event.decision.title });
        break;
      case "project-work.decision.accepted":
        next.decisions = (next.decisions ?? []).map((decision) =>
          decision.decisionId === event.decisionId && decision.state === "proposed"
            ? {
                ...decision,
                state: "accepted",
                updatedAt: event.acceptedAt,
                ...(event.attribution === undefined
                  ? {}
                  : { stateTransitionAttribution: event.attribution }),
                revision: decision.revision + 1,
              }
            : decision,
        );
        appendActivity(next, event, {
          kind: "decision.accepted",
          summary: String(event.decisionId),
        });
        break;
      case "project-work.decision.rejected":
        next.decisions = (next.decisions ?? []).map((decision) =>
          decision.decisionId === event.decisionId && decision.state === "proposed"
            ? {
                ...decision,
                state: "rejected",
                rejectionReason: event.reason,
                rejectedAt: event.rejectedAt,
                updatedAt: event.rejectedAt,
                ...(event.attribution === undefined
                  ? {}
                  : { stateTransitionAttribution: event.attribution }),
                revision: decision.revision + 1,
              }
            : decision,
        );
        appendActivity(next, event, { kind: "decision.rejected", summary: event.reason });
        break;
      case "project-work.decision.superseded":
        next.decisions = (next.decisions ?? []).map((decision) =>
          decision.decisionId === event.decisionId
            ? {
                ...decision,
                state: "superseded",
                updatedAt: event.supersededAt,
                ...(event.attribution === undefined
                  ? {}
                  : { stateTransitionAttribution: event.attribution }),
                revision: decision.revision + 1,
              }
            : decision,
        );
        if (
          !next.decisions.some((decision) => decision.decisionId === event.replacement.decisionId)
        )
          next.decisions.push({ ...event.replacement });
        appendActivity(next, event, {
          kind: "decision.superseded",
          summary: event.replacement.title,
        });
        break;
      case "project-work.comment.added":
        if (!next.comments?.some((comment) => comment.commentId === event.comment.commentId))
          next.comments?.push({ ...event.comment });
        appendActivity(next, event, {
          ...(event.comment.taskId === undefined ? {} : { taskId: event.comment.taskId }),
          kind: "comment.added",
          summary: event.comment.body,
        });
        break;
      case "project-work.attention.seen":
        {
          const existing = next.attention.find(
            (attention) => attention.taskId === event.taskId && attention.resolvedAt === undefined,
          );
          if (existing !== undefined) {
            next.attention = next.attention.map((attention) =>
              attention === existing
                ? { ...attention, seenAt: event.seenAt, revision: attention.revision + 1 }
                : attention,
            );
          } else {
            const task = currentTask(next, event.taskId);
            const reason =
              task.state === "blocked"
                ? "blocked"
                : task.state === "failed"
                  ? "failed"
                  : task.state === "in-review"
                    ? "needs-review"
                    : "stale";
            next.attention.push({
              taskId: event.taskId,
              reason,
              seenAt: event.seenAt,
              revision: event.revision,
            });
          }
        }
        appendActivity(next, event, {
          taskId: event.taskId,
          kind: "attention.seen",
          summary: "Attention marked seen",
        });
        break;
      case "project-work.task.blocked":
        next.blockers.push(event.blocker);
        updateTask(next, event.taskId, {
          state: "blocked",
          blockerId: event.blocker.blockerId,
          revision: currentTask(next, event.taskId).revision + 1,
          updatedAt: event.blockedAt,
        });
        break;
      case "project-work.task.blocker-resolved": {
        const task = currentTask(next, event.taskId);
        const blocker = assertKnownBlocker(next, event.blockerId);
        const index = next.blockers.findIndex((entry) => entry.blockerId === blocker.blockerId);
        next.blockers[index] = {
          ...blocker,
          resolvedAt: event.resolvedAt,
          attention: false,
          revision: blocker.revision + 1,
        };
        updateTask(next, event.taskId, {
          state: "specified",
          blockerId: undefined,
          revision: task.revision + 1,
          updatedAt: event.resolvedAt,
        });
        updateTask(next, event.taskId, {
          state: stateForReadiness(next, event.taskId, event.resolvedAt),
        });
        break;
      }
      case "project-work.task.reopened":
        updateTask(next, event.taskId, {
          state: event.state,
          completedAt: undefined,
          failureKind: undefined,
          updatedAt: event.reopenedAt,
          revision: currentTask(next, event.taskId).revision + 1,
        });
        break;
      case "project-work.task.canceled": {
        const task = currentTask(next, event.taskId);
        next.attempts = next.attempts.map((attempt) =>
          attempt.taskId === event.taskId &&
          (attempt.state === "leased" || attempt.state === "running")
            ? {
                ...attempt,
                state: "canceled",
                endedAt: event.canceledAt,
                revision: attempt.revision + 1,
              }
            : attempt,
        );
        updateTask(next, event.taskId, {
          state: "canceled",
          canceledAt: event.canceledAt,
          activeAttemptId: undefined,
          updatedAt: event.canceledAt,
          revision: task.revision + 1,
        });
        break;
      }
      case "project-work.task.duplicated":
        next.tasks.push(event.task);
        next.relationships.push(event.relationship);
        break;
      case "project-work.task.approved":
        updateTask(next, event.taskId, {
          approval: event.approval,
          updatedAt: event.approvedAt,
          revision: currentTask(next, event.taskId).revision + 1,
        });
        break;
      case "project-work.task.assigned":
        updateTask(next, event.taskId, {
          assignee: event.assignee,
          updatedAt: event.assignedAt,
          revision: currentTask(next, event.taskId).revision + 1,
        });
        break;
      case "project-work.task.watched": {
        const task = currentTask(next, event.taskId);
        updateTask(next, event.taskId, {
          watchers: [...(task.watchers ?? []), event.watcher],
          updatedAt: event.watchedAt,
          revision: task.revision + 1,
        });
        break;
      }
      case "project-work.task.unwatched": {
        const task = currentTask(next, event.taskId);
        updateTask(next, event.taskId, {
          watchers: (task.watchers ?? []).filter(
            (watcher) => projectWorkActorKey(watcher) !== projectWorkActorKey(event.watcher),
          ),
          updatedAt: event.unwatchedAt,
          revision: task.revision + 1,
        });
        break;
      }
      case "project-work.task.specification-protected": {
        const task = currentTask(next, event.taskId);
        if (task.specification !== undefined)
          updateTask(next, event.taskId, {
            specification: { ...task.specification, protected: true },
            updatedAt: event.protectedAt,
            revision: task.revision + 1,
          });
        break;
      }
      case "project-work.criterion.upserted": {
        const index = next.criteria.findIndex(
          (criterion) => criterion.criterionId === event.criterion.criterionId,
        );
        if (index < 0) next.criteria.push(event.criterion);
        else next.criteria[index] = event.criterion;
        break;
      }
      case "project-work.criterion.waived": {
        const index = next.criteria.findIndex(
          (criterion) => criterion.criterionId === event.criterionId,
        );
        if (index >= 0)
          next.criteria[index] = {
            ...next.criteria[index]!,
            status: "waived",
            waiver: event.waiver,
            revision: next.criteria[index]!.revision + 1,
            updatedAt: event.waivedAt,
          };
        break;
      }
      case "project-work.evidence.added":
        next.evidence.push(event.evidence);
        break;
      case "project-work.relationship.linked":
        next.relationships.push(event.relationship);
        break;
      case "project-work.relationship.unlinked":
        next.relationships = next.relationships.filter(
          (relationship) => relationship.relationshipId !== event.relationshipId,
        );
        break;
    }
    if (event.type !== "project-work.activity.recorded") {
      const taskId =
        "taskId" in event
          ? event.taskId
          : event.type === "project-work.task.created" ||
              event.type === "project-work.task.duplicated"
            ? event.task.taskId
            : undefined;
      const attemptId =
        "attemptId" in event
          ? event.attemptId
          : event.type === "project-work.task.claimed"
            ? event.attempt.attemptId
            : undefined;
      appendActivity(next, event, {
        ...(taskId === undefined ? {} : { taskId }),
        ...(attemptId === undefined ? {} : { attemptId }),
      });
      if (taskId !== undefined) reconcileTaskAttention(next, taskId, event.occurredAt);
    }
  }
  return next;
}

export const projectWorkResultInvalidationsFor = (
  state: ProjectWorkState,
): ReadonlyArray<ProjectWorkResultInvalidation> =>
  (state as ProjectWorkReducerState).resultInvalidations ?? [];
