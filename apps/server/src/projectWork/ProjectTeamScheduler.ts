import type { ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { decideProjectWorkCommand, type ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import type {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import {
  deriveProjectWorkClaimPrerequisites,
  ProjectWorkPolicyError,
} from "./ProjectWorkPolicy.ts";

type Journal = Effect.Success<ReturnType<typeof makeProjectTeamDispatchJournal>>;
export type ProjectTeamSchedulerCommitted = Effect.Success<ReturnType<Journal["reserve"]>>;
type Candidate = { readonly taskId: ProjectWorkTaskId; readonly priority: number };
type Project = { readonly projectId: ProjectId; readonly priority: number };

/** Root reads current authority, retains stable request identities across uncertain failures,
 * and supplies the actual atomic journal. Notification only hints at committed outbox work. */
export interface ProjectTeamSchedulerPorts<E> {
  readProjectPage(input: {
    afterProjectId?: ProjectId;
    limit: number;
  }): Effect.Effect<ReadonlyArray<Project>, E>;
  readProjectState(input: {
    projectId: ProjectId;
    afterTaskId?: ProjectWorkTaskId;
    limit: number;
  }): Effect.Effect<{ state: ProjectWorkReducerState; candidates: ReadonlyArray<Candidate> }, E>;
  prepareRequest(input: {
    state: ProjectWorkReducerState;
    taskId: ProjectWorkTaskId;
    nowMs: number;
  }): Effect.Effect<
    { _tag: "Prepared"; request: ProjectTeamDispatchRequest } | { _tag: "Blocked"; reason: string },
    E
  >;
  reserve(request: ProjectTeamDispatchRequest): Effect.Effect<ProjectTeamSchedulerCommitted, E>;
  notifyCommittedDispatch?: (result: ProjectTeamSchedulerCommitted) => Effect.Effect<void, E>;
}

export interface ProjectTeamSchedulerBlocked<E> {
  readonly projectId: ProjectId;
  readonly taskId?: ProjectWorkTaskId;
  readonly phase: "read" | "eligibility" | "prepare" | "reserve" | "notify";
  readonly reason: string;
  readonly error?: E;
}

const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const Sweep = Schema.Struct({
  projects: Schema.optionalKey(Positive.check(Schema.isLessThanOrEqualTo(32))),
  tasksPerProject: Schema.optionalKey(Positive.check(Schema.isLessThanOrEqualTo(64))),
  maximumReservations: Schema.optionalKey(Positive.check(Schema.isLessThanOrEqualTo(32))),
});
const decodeSweep = Schema.decodeEffect(Sweep, { onExcessProperty: "error" });
export class ProjectTeamSchedulerError extends Schema.TaggedError<ProjectTeamSchedulerError>()(
  "ProjectTeamSchedulerError",
  { reason: Schema.String },
) {}
const invalid = (reason: string) => new ProjectTeamSchedulerError({ reason });
const validPriority = Schema.is(
  Schema.Int.check(
    Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
);
const validId = Schema.is(
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
);
/** SQLite BINARY keysets compare UTF-8 bytes, including IDs outside the BMP. */
export const compareProjectTeamSchedulingIds = (a: string, b: string) =>
  NodeBuffer.Buffer.compare(NodeBuffer.Buffer.from(a), NodeBuffer.Buffer.from(b));
const ascending = <T>(page: ReadonlyArray<T>, id: (entry: T) => string, after?: string) =>
  page.every(
    (entry, index) =>
      validId(id(entry)) &&
      (index === 0
        ? after === undefined || compareProjectTeamSchedulingIds(id(entry), after) > 0
        : compareProjectTeamSchedulingIds(id(entry), id(page[index - 1]!)) > 0),
  );
const byPriority =
  <T extends { readonly priority: number }>(id: (entry: T) => string) =>
  (a: T, b: T) =>
    b.priority - a.priority || compareProjectTeamSchedulingIds(id(a), id(b));

type TaskWindow = {
  readonly afterTaskId?: ProjectWorkTaskId;
  readonly limit: number;
  readonly candidates: Array<Candidate>;
  readonly visited: Set<ProjectWorkTaskId>;
};

/** A wake-driven bounded sweep. These cursors and pending IDs are disposable selection state;
 * the journal, not this adapter, owns assignments, budgets and recovery after a lost wake. */
export const makeProjectTeamScheduler = Effect.fn("makeProjectTeamScheduler")(function* <
  E,
>(options: { environmentId: string; ports: ProjectTeamSchedulerPorts<E> }) {
  if (!validId(options.environmentId)) return yield* invalid("Invalid environment identity");
  const lock = yield* Semaphore.make(1);
  const ports = options.ports;
  let afterProjectId: ProjectId | undefined;
  let projects: Array<Project> = [];
  const taskCursors = new Map<ProjectId, ProjectWorkTaskId>();
  const windows = new Map<ProjectId, TaskWindow>();
  const seenProjects = new Set<ProjectId>();

  const sweep = Effect.fn("ProjectTeamScheduler.sweep")(function* (input: typeof Sweep.Type = {}) {
    const limits = yield* decodeSweep(input).pipe(
      Effect.mapError(() => invalid("Invalid sweep bounds")),
    );
    const projectLimit = limits.projects ?? 32;
    const taskLimit = limits.tasksPerProject ?? 64;
    const reservationLimit = limits.maximumReservations ?? 32;
    const committed: Array<ProjectTeamSchedulerCommitted> = [];
    const blocked: Array<ProjectTeamSchedulerBlocked<E>> = [];
    const notificationFailures: Array<ProjectTeamSchedulerCommitted> = [];
    let projectsScanned = 0;
    let tasksScanned = 0;
    if (projects.length === 0) {
      const page = yield* ports.readProjectPage({
        ...(afterProjectId === undefined ? {} : { afterProjectId }),
        limit: projectLimit,
      });
      if (
        page.length > projectLimit ||
        !ascending(page, (p) => p.projectId, afterProjectId) ||
        page.some((p) => !validPriority(p.priority))
      )
        return yield* invalid("Invalid project keyset page");
      afterProjectId = page.length === projectLimit ? page[page.length - 1]!.projectId : undefined;
      for (const project of page) seenProjects.add(project.projectId);
      if (afterProjectId === undefined) {
        for (const projectId of windows.keys())
          if (!seenProjects.has(projectId)) windows.delete(projectId);
        for (const projectId of taskCursors.keys())
          if (!seenProjects.has(projectId)) taskCursors.delete(projectId);
        seenProjects.clear();
      }
      projects = [...page].sort(byPriority((p: Project) => p.projectId));
    }
    // Each project gets one visit per keyset sweep; pending tasks survive to the next
    // pass. Cursor progress follows keyset order, not priority order.
    const visits = Math.min(projectLimit, projects.length);
    for (let visit = 0; visit < visits && committed.length < reservationLimit; visit++) {
      const project = projects.shift()!;
      projectsScanned++;
      const window = windows.get(project.projectId);
      const afterTaskId =
        window?.afterTaskId ??
        (window === undefined ? taskCursors.get(project.projectId) : undefined);
      const pageLimit = window?.limit ?? taskLimit;
      const loaded = yield* ports
        .readProjectState({
          projectId: project.projectId,
          ...(afterTaskId === undefined ? {} : { afterTaskId }),
          limit: pageLimit,
        })
        .pipe(Effect.result);
      if (loaded._tag === "Failure") {
        blocked.push({
          projectId: project.projectId,
          phase: "read",
          reason: "project-read-failed",
          error: loaded.failure,
        });
        continue;
      }
      const { state, candidates } = loaded.success;
      if (
        state.projectId !== project.projectId ||
        candidates.length > pageLimit ||
        !ascending(candidates, (c) => c.taskId, afterTaskId) ||
        candidates.some((c) => !validPriority(c.priority)) ||
        candidates.some(
          (c) =>
            state.tasks.filter((t) => t.taskId === c.taskId && t.projectId === project.projectId)
              .length !== 1,
        )
      ) {
        blocked.push({
          projectId: project.projectId,
          phase: "read",
          reason: "invalid-task-keyset-page",
        });
        continue;
      }
      // Refresh from all current eligible IDs and priorities, including replacements.
      // Remember visits only within this bounded page so repeated high-priority IDs
      // cannot starve its remaining tasks; cursor progress follows the actual keyset.
      const currentIds = new Set(candidates.map((c) => c.taskId));
      const visited = new Set([...(window?.visited ?? [])].filter((id) => currentIds.has(id)));
      const pending: TaskWindow = {
        ...(afterTaskId === undefined ? {} : { afterTaskId }),
        limit: pageLimit,
        candidates: candidates
          .filter((c) => !visited.has(c.taskId))
          .sort(byPriority((c: Candidate) => c.taskId)),
        visited,
      };
      // Publish before any interruptible preparation, transaction or notification.
      // Keep the selected ID until a definitive result; the journal remains durable
      // authority if a transaction commits without returning its result to this fiber.
      if (pending.candidates.length > 0) windows.set(project.projectId, pending);
      else windows.delete(project.projectId);
      if (candidates.length === pageLimit)
        taskCursors.set(project.projectId, candidates[candidates.length - 1]!.taskId);
      else taskCursors.delete(project.projectId);
      // Visits expire with the bounded window. A denied task remains ready in SQL and is
      // selected again from fresh authority after keyset traversal wraps; no retry wake is added.
      const consumeCandidate = () => {
        pending.visited.add(pending.candidates.shift()!.taskId);
        if (pending.candidates.length === 0) windows.delete(project.projectId);
      };
      let scanned = 0;
      while (
        pending.candidates.length > 0 &&
        scanned < taskLimit &&
        committed.length < reservationLimit
      ) {
        const candidate = pending.candidates[0]!;
        scanned++;
        tasksScanned++;
        const taskId = candidate.taskId;
        const memberships = (state.foundationRecords ?? []).filter(
          (r) => r.kind === "task-membership" && r.taskId === taskId,
        );
        const membership = memberships[0];
        if (
          memberships.length !== 1 ||
          membership?.kind !== "task-membership" ||
          membership.projectId !== project.projectId ||
          membership.executionKind !== "managed" ||
          membership.status !== "active" ||
          (membership.controlState !== undefined && membership.controlState !== "active") ||
          membership.assignment === undefined
        ) {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "eligibility",
            reason: "inactive-managed-assignment",
          });
          consumeCandidate();
          continue;
        }
        const grants = (state.foundationRecords ?? []).filter(
          (r) => r.kind === "gate" && r.recordId === membership.assignment!.authorizationGateId,
        );
        const grant = grants[0];
        if (
          grants.length !== 1 ||
          grant?.kind !== "gate" ||
          grant.projectId !== project.projectId ||
          grant.taskId !== taskId ||
          grant.attribution.actor.kind !== "human" ||
          !["investigation", "assignment", "execution", "repair"].includes(grant.gate) ||
          (grant.status !== "approved" && grant.status !== "consumed")
        ) {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "eligibility",
            reason: "explicit-authorization-required",
          });
          consumeCandidate();
          continue;
        }
        const prerequisite = yield* Effect.try({
          try: () => deriveProjectWorkClaimPrerequisites(state, taskId),
          catch: (error) =>
            error instanceof ProjectWorkPolicyError ? error : invalid("Invalid policy state"),
        }).pipe(Effect.result);
        if (prerequisite._tag === "Failure" || !prerequisite.success.claimable) {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "eligibility",
            reason:
              prerequisite._tag === "Failure"
                ? "invalid-task"
                : (prerequisite.success.reason ?? "task-not-claimable"),
          });
          consumeCandidate();
          continue;
        }
        const prepared = yield* ports
          .prepareRequest({ state, taskId, nowMs: yield* Clock.currentTimeMillis })
          .pipe(Effect.result);
        if (prepared._tag === "Failure") {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "prepare",
            reason: "request-preparation-failed",
            error: prepared.failure,
          });
          consumeCandidate();
          continue;
        }
        if (prepared.success._tag === "Blocked") {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "prepare",
            reason: prepared.success.reason,
          });
          consumeCandidate();
          continue;
        }
        const request = prepared.success.request;
        const transition = request.claim.transition;
        if (
          request.claim.projectId !== project.projectId ||
          request.claim.expectedRevision !== state.revision ||
          transition?.kind !== "claim" ||
          transition.taskId !== taskId ||
          transition.binding.environmentId !== options.environmentId ||
          transition.dispatch !== undefined ||
          request.claim.guided !== undefined
        ) {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "prepare",
            reason: "prepared-identity-mismatch",
          });
          consumeCandidate();
          continue;
        }
        const policy = yield* Effect.try({
          try: () => decideProjectWorkCommand(state, request.claim),
          catch: (error) =>
            error instanceof ProjectWorkPolicyError ? error : invalid("Invalid policy state"),
        }).pipe(Effect.result);
        if (policy._tag === "Failure") {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "eligibility",
            reason:
              policy.failure instanceof ProjectWorkPolicyError
                ? policy.failure.code
                : "invalid-prepared-claim",
          });
          consumeCandidate();
          continue;
        }
        const reserved = yield* ports.reserve(request).pipe(Effect.result);
        if (reserved._tag === "Failure") {
          blocked.push({
            projectId: project.projectId,
            taskId,
            phase: "reserve",
            reason: "reservation-denied",
            error: reserved.failure,
          });
          // A denial skips this visit, not the durable ready task. Finish the bounded window
          // before fresh discovery retries it, so other siblings can use different capacity.
          consumeCandidate();
          continue;
        }
        consumeCandidate();
        committed.push(reserved.success);
        if (ports.notifyCommittedDispatch !== undefined) {
          const notified = yield* ports
            .notifyCommittedDispatch(reserved.success)
            .pipe(Effect.result);
          if (notified._tag === "Failure") {
            notificationFailures.push(reserved.success);
            blocked.push({
              projectId: project.projectId,
              taskId,
              phase: "notify",
              reason: "notification-failed",
              error: notified.failure,
            });
          }
        }
        // A later claim must use a fresh project revision after this transaction commits.
        break;
      }
    }
    return {
      committed,
      blocked,
      projectsScanned,
      tasksScanned,
      notificationFailures,
      hasMore:
        projects.length > 0 ||
        afterProjectId !== undefined ||
        taskCursors.size > 0 ||
        windows.size > 0,
    };
  });
  return { sweep: (input: typeof Sweep.Type = {}) => lock.withPermits(1)(sweep(input)) };
});
