import type {
  ProjectWorkAction,
  ProjectWorkActionAvailability,
  ProjectWorkAttention,
  ProjectWorkClaimability,
  ProjectWorkCriterion,
  ProjectWorkEvidence,
  ProjectWorkReadiness,
  ProjectWorkReadinessReason,
  ProjectWorkRelationship,
  ProjectWorkTask,
  ProjectWorkTaskId,
  ProjectWorkAttempt,
  ProjectWorkBlocker,
  ProjectWorkAttribution,
  ProjectWorkApproval,
  ProjectWorkActor,
  ProjectWorkResultInvalidation,
} from "@t3tools/contracts";

export type ProjectWorkPolicyFailureCode =
  | "unknown-task"
  | "unknown-criterion"
  | "unknown-evidence"
  | "unknown-relationship"
  | "unknown-blocker"
  | "stale-revision"
  | "invalid-state"
  | "invalid-specification"
  | "invalid-relationship"
  | "active-attempt"
  | "unresolved-dependency"
  | "unsatisfied-criterion"
  | "protected-specification"
  | "approval-required"
  | "authority-required"
  | "duplicate-record"
  | "deferred-command";

/** A domain rejection that callers can map to a typed command receipt. */
export class ProjectWorkPolicyError extends Error {
  readonly _tag = "ProjectWorkPolicyError";
  readonly code: ProjectWorkPolicyFailureCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ProjectWorkPolicyFailureCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ProjectWorkPolicyError";
    this.code = code;
    this.details = details;
  }
}

export interface ProjectWorkState {
  readonly projectId: string;
  revision: number;
  tasks: Array<ProjectWorkTask>;
  attempts: Array<ProjectWorkAttempt>;
  criteria: Array<ProjectWorkCriterion>;
  evidence: Array<ProjectWorkEvidence>;
  relationships: Array<ProjectWorkRelationship>;
  blockers: Array<ProjectWorkBlocker>;
  attention: Array<ProjectWorkAttention>;
  /** Optional reducer-owned audit history; persistence may hydrate it lazily. */
  readonly history?: ReadonlyArray<{
    readonly eventId: string;
    readonly type: string;
    readonly revision: number;
    readonly occurredAt: string;
  }>;
  readonly resultInvalidations?: ReadonlyArray<ProjectWorkResultInvalidation>;
}

export interface ProjectWorkTaskPolicy {
  readonly taskId: ProjectWorkTaskId;
  readonly readiness: ProjectWorkReadiness;
  readonly claimability: ProjectWorkClaimability;
  readonly actions: Readonly<Record<ProjectWorkAction, ProjectWorkActionAvailability>>;
  readonly attention: ReadonlyArray<ProjectWorkAttention>;
}

const ACTIONS: ReadonlyArray<ProjectWorkAction> = [
  "specify",
  "ready",
  "claim",
  "complete",
  "fail",
  "resolve-failure",
  "revise-protected-specification",
  "reclaim",
  "takeover",
  "block",
  "resolve-blocker",
  "reopen",
  "cancel",
  "duplicate",
  "approve",
  "assign",
  "watch",
  "unwatch",
  "protect-specification",
  "waive-criterion",
  "add-evidence",
  "link-relationship",
  "unlink-relationship",
];

const activeAttemptStates = new Set(["leased", "running"]);
const terminalStates = new Set(["completed", "canceled"]);

const taskFor = (state: ProjectWorkState, taskId: ProjectWorkTaskId): ProjectWorkTask => {
  const task = state.tasks.find((entry) => entry.taskId === taskId);
  if (task === undefined) {
    throw new ProjectWorkPolicyError("unknown-task", `Task '${taskId}' does not exist.`, {
      taskId,
    });
  }
  return task;
};

const activeAttemptFor = (state: ProjectWorkState, taskId: ProjectWorkTaskId) =>
  state.attempts.find(
    (attempt) => attempt.taskId === taskId && activeAttemptStates.has(attempt.state),
  );

const criterionFor = (state: ProjectWorkState, criterionId: string): ProjectWorkCriterion => {
  const criterion = state.criteria.find((entry) => entry.criterionId === criterionId);
  if (criterion === undefined) {
    throw new ProjectWorkPolicyError(
      "unknown-criterion",
      `Criterion '${criterionId}' does not exist.`,
      { criterionId },
    );
  }
  return criterion;
};

const dependencyEdges = (state: ProjectWorkState) =>
  state.relationships
    .filter((relationship) => relationship.kind === "depends-on" || relationship.kind === "blocks")
    .map((relationship) =>
      relationship.kind === "depends-on"
        ? { from: String(relationship.fromTaskId), to: String(relationship.toTaskId) }
        : { from: String(relationship.toTaskId), to: String(relationship.fromTaskId) },
    );

/** Finds a dependency path from `start` back to itself if adding an edge would cycle. */
export function findProjectWorkDependencyCycle(
  state: ProjectWorkState,
  fromTaskId: ProjectWorkTaskId,
  toTaskId: ProjectWorkTaskId,
): ReadonlyArray<string> | undefined {
  const edges = [...dependencyEdges(state), { from: String(fromTaskId), to: String(toTaskId) }];
  const nextByTask = new Map<string, Array<string>>();
  for (const edge of edges) {
    const next = nextByTask.get(edge.from) ?? [];
    next.push(edge.to);
    nextByTask.set(edge.from, next);
  }
  const target = String(fromTaskId);
  const start = String(toTaskId);
  const queue: Array<{ node: string; path: Array<string> }> = [{ node: start, path: [start] }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.node === target) return [String(fromTaskId), ...current.path];
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    for (const next of nextByTask.get(current.node) ?? []) {
      queue.push({ node: next, path: [...current.path, next] });
    }
  }
  return undefined;
}

function readinessFor(state: ProjectWorkState, task: ProjectWorkTask): ProjectWorkReadiness {
  const reasons: Array<ProjectWorkReadinessReason> = [];
  const specification = task.specification;
  if (specification === undefined) {
    reasons.push("missing-specification");
  } else {
    for (const criterionId of specification.criterionIds) {
      const criterion = state.criteria.find((entry) => entry.criterionId === criterionId);
      if (criterion === undefined || criterion.taskId !== task.taskId) {
        reasons.push("missing-criterion");
      }
    }
    if (specification.protected && task.approval?.specRevision !== specification.revision) {
      reasons.push("approval-required");
    }
  }
  if (task.blockerId !== undefined) {
    const blocker = state.blockers.find(
      (entry) => entry.blockerId === task.blockerId && entry.resolvedAt === undefined,
    );
    if (blocker !== undefined) reasons.push("active-blocker");
  }
  const activeAttempt = activeAttemptFor(state, task.taskId);
  if (activeAttempt !== undefined) reasons.push("active-attempt");
  for (const edge of dependencyEdges(state)) {
    if (edge.from !== String(task.taskId)) continue;
    const dependency = state.tasks.find((entry) => String(entry.taskId) === edge.to);
    if (dependency === undefined || dependency.state !== "completed") {
      reasons.push("unresolved-dependency");
    }
  }
  if (task.failureKind === "manual-triage") reasons.push("manual-triage-failure");
  if (task.state === "canceled") reasons.push("canceled");
  if (task.state === "completed") reasons.push("completed");
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function claimabilityFor(
  state: ProjectWorkState,
  task: ProjectWorkTask,
  readiness: ProjectWorkReadiness,
): ProjectWorkClaimability {
  if (
    task.state !== "ready" &&
    !(
      task.state === "failed" &&
      (task.failureKind === "recoverable" || task.failureKind === "lease-expired")
    )
  ) {
    return { claimable: false, reason: "task-not-ready" };
  }
  if (activeAttemptFor(state, task.taskId) !== undefined) {
    return { claimable: false, reason: "active-attempt" };
  }
  if (!readiness.ready) {
    return { claimable: false, reason: readiness.reasons[0] ?? "not-ready" };
  }
  return { claimable: true };
}

function availability(available: boolean, reason?: string): ProjectWorkActionAvailability {
  return available || reason === undefined ? { available } : { available, reason };
}

function attentionFor(
  state: ProjectWorkState,
  task: ProjectWorkTask,
  now: string,
): ReadonlyArray<ProjectWorkAttention> {
  const next: Array<ProjectWorkAttention> = [];
  const add = (reason: ProjectWorkAttention["reason"], detail?: string) => {
    next.push({
      taskId: task.taskId,
      reason,
      ...(detail === undefined ? {} : { detail }),
      revision: task.revision,
    });
  };
  if (task.state === "blocked") add("blocked", task.blockerId);
  if (task.state === "failed") add("failed", task.failureKind);
  if (task.state === "in-review") add("needs-review");
  if (
    task.specification?.protected === true &&
    task.approval?.specRevision !== task.specification.revision
  ) {
    add(
      "approval-required",
      `Specification revision ${task.specification.revision} requires approval.`,
    );
  }
  const activeAttempt = activeAttemptFor(state, task.taskId);
  if (
    activeAttempt?.leasedUntil !== undefined &&
    Date.parse(activeAttempt.leasedUntil) <= Date.parse(now)
  ) {
    add("stale", "The active lease is past its expiry.");
  }
  return next;
}

const actorKey = (actor: ProjectWorkActor): string =>
  `${actor.kind}:${actor.id ?? actor.displayName ?? "anonymous"}`;

/**
 * Computes all command availability for a task. The client may display this
 * result, but the decider always recomputes it before accepting a command.
 */
export function deriveProjectWorkTaskPolicy(
  state: ProjectWorkState,
  taskId: ProjectWorkTaskId,
  now?: string,
): ProjectWorkTaskPolicy {
  const task = taskFor(state, taskId);
  const readiness = readinessFor(state, task);
  const claimability = claimabilityFor(state, task, readiness);
  const actions = Object.fromEntries(
    ACTIONS.map((action) => [action, availability(false, "not-available")]),
  ) as Record<ProjectWorkAction, ProjectWorkActionAvailability>;
  actions.specify = availability(
    (task.state === "draft" || task.state === "specified") &&
      task.specification?.protected !== true,
    task.specification?.protected === true ? "protected-specification" : undefined,
  );
  actions.ready = availability(task.state === "specified" && readiness.ready, readiness.reasons[0]);
  actions.claim = claimability.claimable
    ? availability(true)
    : availability(false, claimability.reason);
  const canCompleteState = task.state === "in-progress" || task.state === "in-review";
  const requiredCriteria = requiredCriteriaFor(state, task);
  const hasUnsatisfiedCriteria = requiredCriteria.some(
    (criterion) => criterion.status !== "satisfied" && criterion.status !== "waived",
  );
  const activeAttempt = activeAttemptFor(state, task.taskId);
  actions.complete = availability(
    canCompleteState && activeAttempt !== undefined && !hasUnsatisfiedCriteria,
    !canCompleteState
      ? "task-not-running"
      : activeAttempt === undefined
        ? "no-active-attempt"
        : "unsatisfied-criterion",
  );
  actions.fail = availability(
    canCompleteState && activeAttempt !== undefined,
    !canCompleteState ? "task-not-running" : "no-active-attempt",
  );
  actions["resolve-failure"] = availability(task.state === "failed", "task-not-failed");
  actions["revise-protected-specification"] = availability(
    task.specification?.protected === true && task.state !== "canceled",
    task.specification?.protected === true ? "canceled-task" : "specification-not-protected",
  );
  const reclaimableAttempt = [...state.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.taskId === task.taskId &&
        (attempt.state === "failed" || attempt.state === "expired") &&
        attempt.failureResolvedAt === undefined,
    );
  actions.reclaim = availability(
    claimability.claimable &&
      reclaimableAttempt !== undefined &&
      reclaimableAttempt.failureKind !== "manual-triage",
    task.failureKind === "manual-triage" || reclaimableAttempt?.failureKind === "manual-triage"
      ? "manual-triage-failure"
      : reclaimableAttempt === undefined
        ? "no-reclaimable-attempt"
        : claimability.reason,
  );
  actions.takeover = availability(
    activeAttempt !== undefined && !terminalStates.has(task.state),
    activeAttempt === undefined ? "no-active-attempt" : "terminal-task",
  );
  actions.block = availability(!terminalStates.has(task.state), "terminal-task");
  actions["resolve-blocker"] = availability(task.state === "blocked", "task-not-blocked");
  actions.reopen = availability(
    task.state === "completed" || (task.state === "failed" && task.failureKind === "recoverable"),
    "task-not-reopenable",
  );
  actions.cancel = availability(!terminalStates.has(task.state), "terminal-task");
  actions.duplicate = availability(task.state !== "canceled", "canceled-task");
  actions.approve = availability(
    task.specification !== undefined &&
      task.approval?.specRevision !== task.specification.revision &&
      task.state !== "canceled",
    "no-pending-approval",
  );
  actions.assign = availability(task.state !== "canceled", "canceled-task");
  actions.watch = availability(task.state !== "canceled", "canceled-task");
  actions.unwatch = availability((task.watchers ?? []).length > 0, "not-watching");
  actions["protect-specification"] = availability(
    task.specification !== undefined && !task.specification.protected && task.state !== "canceled",
    task.specification === undefined ? "not-specified" : "already-protected",
  );
  actions["waive-criterion"] = availability(
    requiredCriteriaFor(state, task).some((criterion) => criterion.status === "unsatisfied"),
    "no-unsatisfied-criterion",
  );
  actions["add-evidence"] = availability(task.state !== "canceled", "canceled-task");
  actions["link-relationship"] = availability(task.state !== "canceled", "canceled-task");
  actions["unlink-relationship"] = availability(
    state.relationships.some(
      (relationship) =>
        relationship.fromTaskId === task.taskId || relationship.toTaskId === task.taskId,
    ),
    "no-relationship",
  );
  return {
    taskId,
    readiness,
    claimability,
    actions,
    attention: attentionFor(state, task, now ?? task.updatedAt),
  };
}

export function requiredCriteriaFor(
  state: ProjectWorkState,
  task: ProjectWorkTask,
): ReadonlyArray<ProjectWorkCriterion> {
  const ids = new Set(task.specification?.criterionIds ?? []);
  return state.criteria.filter(
    (criterion) =>
      criterion.taskId === task.taskId && (criterion.required || ids.has(criterion.criterionId)),
  );
}

export function assertProjectWorkExpectedRevision(
  state: ProjectWorkState,
  expectedRevision: number | undefined,
  commandType: string,
): void {
  if (expectedRevision !== undefined && expectedRevision !== state.revision) {
    throw new ProjectWorkPolicyError(
      "stale-revision",
      `Expected project-work revision ${expectedRevision}, current revision is ${state.revision}.`,
      { commandType, expectedRevision, currentRevision: state.revision },
    );
  }
}

export function assertProjectWorkAttribution(
  attribution: ProjectWorkAttribution | undefined,
  commandType: string,
  kind: "human" | "agent" = "human",
): ProjectWorkAttribution {
  if (attribution === undefined || attribution.actor.kind !== kind) {
    throw new ProjectWorkPolicyError(
      "authority-required",
      `${commandType} requires attribution by a ${kind}.`,
      { commandType, requiredActorKind: kind },
    );
  }
  return attribution;
}

export function assertNoActiveAttempt(state: ProjectWorkState, taskId: ProjectWorkTaskId): void {
  const attempt = activeAttemptFor(state, taskId);
  if (attempt !== undefined) {
    throw new ProjectWorkPolicyError(
      "active-attempt",
      `Task '${taskId}' already has an active attempt.`,
      {
        taskId,
        attemptId: attempt.attemptId,
      },
    );
  }
}

export function assertKnownTask(
  state: ProjectWorkState,
  taskId: ProjectWorkTaskId,
): ProjectWorkTask {
  return taskFor(state, taskId);
}

export function assertKnownCriterion(
  state: ProjectWorkState,
  criterionId: string,
): ProjectWorkCriterion {
  return criterionFor(state, criterionId);
}

export function assertKnownEvidence(
  state: ProjectWorkState,
  evidenceId: string,
): ProjectWorkEvidence {
  const evidence = state.evidence.find((entry) => entry.evidenceId === evidenceId);
  if (evidence === undefined) {
    throw new ProjectWorkPolicyError(
      "unknown-evidence",
      `Evidence '${evidenceId}' does not exist.`,
      { evidenceId },
    );
  }
  return evidence;
}

export function assertKnownBlocker(state: ProjectWorkState, blockerId: string): ProjectWorkBlocker {
  const blocker = state.blockers.find((entry) => entry.blockerId === blockerId);
  if (blocker === undefined) {
    throw new ProjectWorkPolicyError("unknown-blocker", `Blocker '${blockerId}' does not exist.`, {
      blockerId,
    });
  }
  return blocker;
}

export function assertTaskCanBeReady(
  state: ProjectWorkState,
  taskId: ProjectWorkTaskId,
): ProjectWorkTask {
  const task = taskFor(state, taskId);
  const policy = deriveProjectWorkTaskPolicy(state, taskId);
  if (task.state !== "specified") {
    throw new ProjectWorkPolicyError(
      "invalid-state",
      `Task '${taskId}' must be specified before it is ready.`,
      {
        taskId,
        state: task.state,
      },
    );
  }
  if (!policy.readiness.ready) {
    throw new ProjectWorkPolicyError(
      policy.readiness.reasons.includes("unresolved-dependency")
        ? "unresolved-dependency"
        : policy.readiness.reasons.includes("approval-required")
          ? "approval-required"
          : "invalid-specification",
      `Task '${taskId}' is not ready: ${policy.readiness.reasons.join(", ")}.`,
      { taskId, reasons: policy.readiness.reasons },
    );
  }
  return task;
}

export function assertTaskCanBeCompleted(
  state: ProjectWorkState,
  taskId: ProjectWorkTaskId,
  satisfiedCriterionIds: ReadonlyArray<string>,
): ProjectWorkTask {
  const task = taskFor(state, taskId);
  if (task.state !== "in-progress" && task.state !== "in-review") {
    throw new ProjectWorkPolicyError("invalid-state", `Task '${taskId}' is not running.`, {
      taskId,
    });
  }
  const supplied = new Set(satisfiedCriterionIds);
  const required = requiredCriteriaFor(state, task);
  for (const criterionId of supplied) {
    const criterion = state.criteria.find((entry) => String(entry.criterionId) === criterionId);
    if (criterion === undefined || criterion.taskId !== task.taskId) {
      throw new ProjectWorkPolicyError(
        "unknown-criterion",
        `Criterion '${criterionId}' does not belong to task '${task.taskId}'.`,
        { taskId: task.taskId, criterionId },
      );
    }
    if (!required.some((entry) => entry.criterionId === criterion.criterionId)) {
      throw new ProjectWorkPolicyError(
        "unsatisfied-criterion",
        `Criterion '${criterionId}' is not a required criterion for task '${task.taskId}'.`,
        { taskId: task.taskId, criterionId },
      );
    }
  }
  const unsatisfied = required.filter(
    (criterion) => criterion.status === "unsatisfied" && !supplied.has(criterion.criterionId),
  );
  if (unsatisfied.length > 0) {
    throw new ProjectWorkPolicyError(
      "unsatisfied-criterion",
      `Task '${taskId}' cannot complete while required criteria remain unsatisfied: ${unsatisfied
        .map((criterion) => criterion.criterionId)
        .join(", ")}.`,
      { taskId, criterionIds: unsatisfied.map((criterion) => criterion.criterionId) },
    );
  }
  return task;
}

export function actorIsWatcher(task: ProjectWorkTask, actor: ProjectWorkActor): boolean {
  return (task.watchers ?? []).some((watcher) => actorKey(watcher) === actorKey(actor));
}

export function projectWorkActorKey(actor: ProjectWorkActor): string {
  return actorKey(actor);
}

export function activeProjectWorkAttemptStates(): ReadonlySet<string> {
  return activeAttemptStates;
}
