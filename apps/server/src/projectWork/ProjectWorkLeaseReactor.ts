import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  EventId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  type ProjectWorkAttribution,
  type ProjectWorkAttempt,
} from "@t3tools/contracts";
import {
  applyProjectWorkEvents,
  emptyProjectWorkReducerState,
  type ProjectWorkCheckpoint,
  type ProjectWorkEvent,
} from "./ProjectWorkDecider.ts";
import {
  ProjectWorkRepository,
  type ProjectWorkCommandResult,
  type ProjectWorkRepositoryError,
  type ProjectWorkRepositoryShape,
} from "./ProjectWorkRepository.ts";

export type ProjectWorkLeaseErrorCode =
  | "unknown-attempt"
  | "active-attempt"
  | "lease-expired"
  | "invalid-lease-token"
  | "invalid-attempt-state"
  | "takeover-required"
  | "manual-triage"
  | "duplicate-checkpoint";

/** A typed failure callers can turn into a rejected command receipt. */
export class ProjectWorkLeaseError extends Error {
  readonly _tag = "ProjectWorkLeaseError";
  readonly code: ProjectWorkLeaseErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(
    code: ProjectWorkLeaseErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ProjectWorkLeaseError";
    this.code = code;
    this.details = details;
  }
}

export interface ProjectWorkLeaseClaimInput {
  readonly projectId: string;
  readonly taskId: ProjectWorkTaskId;
  readonly attemptId: ProjectWorkAttemptId;
  readonly leaseToken: string;
  readonly leasedUntil: string;
  readonly claimedAt: string;
  readonly attribution?: ProjectWorkAttribution;
  readonly taskState?: string;
}
export interface ProjectWorkLeaseRenewInput {
  readonly projectId: string;
  readonly taskId: ProjectWorkTaskId;
  readonly attemptId: ProjectWorkAttemptId;
  readonly leaseToken: string;
  readonly leasedUntil: string;
  readonly renewedAt: string;
  readonly attribution?: ProjectWorkAttribution;
}
export interface ProjectWorkCheckpointInput {
  readonly projectId: string;
  readonly taskId: ProjectWorkTaskId;
  readonly attemptId: ProjectWorkAttemptId;
  readonly leaseToken: string;
  readonly checkpointId: string;
  readonly ref?: string;
  readonly capturedAt: string;
  readonly attribution?: ProjectWorkAttribution;
}
export interface ProjectWorkLeaseTakeoverInput extends ProjectWorkLeaseClaimInput {
  readonly previousAttemptId: ProjectWorkAttemptId;
  readonly authorized: boolean;
}

export interface ProjectWorkLeaseReactorShape {
  readonly claim: (
    input: ProjectWorkLeaseClaimInput,
  ) => Effect.Effect<ProjectWorkAttempt, ProjectWorkLeaseError | ProjectWorkRepositoryError>;
  readonly renew: (
    input: ProjectWorkLeaseRenewInput,
  ) => Effect.Effect<ProjectWorkAttempt, ProjectWorkLeaseError | ProjectWorkRepositoryError>;
  readonly renewLease: ProjectWorkLeaseReactorShape["renew"];
  readonly checkpoint: (
    input: ProjectWorkCheckpointInput,
  ) => Effect.Effect<ProjectWorkEvent, ProjectWorkLeaseError | ProjectWorkRepositoryError>;
  readonly checkpointAttempt: ProjectWorkLeaseReactorShape["checkpoint"];
  readonly expire: (input: {
    readonly now: string;
    readonly projectId?: string;
  }) => Effect.Effect<
    ReadonlyArray<ProjectWorkEvent>,
    ProjectWorkLeaseError | ProjectWorkRepositoryError
  >;
  readonly expireLeases: ProjectWorkLeaseReactorShape["expire"];
  readonly reclaim: (
    input: ProjectWorkLeaseClaimInput & { readonly previousAttemptId: ProjectWorkAttemptId },
  ) => Effect.Effect<ProjectWorkAttempt, ProjectWorkLeaseError | ProjectWorkRepositoryError>;
  readonly reclaimAttempt: ProjectWorkLeaseReactorShape["reclaim"];
  readonly takeover: (
    input: ProjectWorkLeaseTakeoverInput,
  ) => Effect.Effect<ProjectWorkAttempt, ProjectWorkLeaseError | ProjectWorkRepositoryError>;
  readonly takeoverAttempt: ProjectWorkLeaseReactorShape["takeover"];
  readonly get: (
    attemptId: ProjectWorkAttemptId,
  ) => Effect.Effect<ProjectWorkAttempt | undefined, ProjectWorkRepositoryError>;
}

export class ProjectWorkLeaseReactor extends Context.Service<
  ProjectWorkLeaseReactor,
  ProjectWorkLeaseReactorShape
>()("t3/projectWork/ProjectWorkLeaseReactor") {}

export const projectWorkLeaseExpired = (
  attempt: Pick<ProjectWorkAttempt, "leasedUntil">,
  now: string,
): boolean =>
  attempt.leasedUntil !== undefined && Date.parse(attempt.leasedUntil) <= Date.parse(now);

export const projectWorkLeaseFenceMatches = (
  attempt: ProjectWorkAttempt,
  leaseToken: string,
  now: string,
): boolean =>
  (attempt.state === "leased" || attempt.state === "running") &&
  attempt.leaseToken === leaseToken &&
  !projectWorkLeaseExpired(attempt, now);

export const assertProjectWorkLeaseFence = (
  attempt: ProjectWorkAttempt | undefined,
  leaseToken: string,
  now: string,
): ProjectWorkAttempt => {
  if (attempt === undefined)
    throw new ProjectWorkLeaseError("unknown-attempt", "Attempt does not exist.");
  if (attempt.state !== "leased" && attempt.state !== "running")
    throw new ProjectWorkLeaseError(
      "invalid-attempt-state",
      `Attempt '${attempt.attemptId}' is ${attempt.state}.`,
      { attemptId: attempt.attemptId },
    );
  if (attempt.leaseToken !== leaseToken)
    throw new ProjectWorkLeaseError(
      "invalid-lease-token",
      "The lease token does not fence this attempt.",
      { attemptId: attempt.attemptId },
    );
  if (projectWorkLeaseExpired(attempt, now))
    throw new ProjectWorkLeaseError("lease-expired", "The attempt lease has expired.", {
      attemptId: attempt.attemptId,
    });
  return attempt;
};

const commandId = (name: string, id: string, at: string): CommandId =>
  CommandId.make(`server:project-work:${name}:${id}:${at}`);

const toLeaseError = (cause: unknown): ProjectWorkLeaseError | unknown => {
  if (!(cause instanceof Error)) return cause;
  const message = cause.message.toLowerCase();
  if (message.includes("manual-triage"))
    return new ProjectWorkLeaseError("manual-triage", cause.message);
  if (message.includes("active attempt"))
    return new ProjectWorkLeaseError("active-attempt", cause.message);
  if (message.includes("token"))
    return new ProjectWorkLeaseError("invalid-lease-token", cause.message);
  if (message.includes("expired")) return new ProjectWorkLeaseError("lease-expired", cause.message);
  if (message.includes("checkpoint"))
    return new ProjectWorkLeaseError("duplicate-checkpoint", cause.message);
  return cause;
};

const makeProjectWorkLeaseReactor = Effect.gen(function* () {
  const repositoryOption = yield* Effect.serviceOption(ProjectWorkRepository);
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const fallbackAttempts = new Map<string, ProjectWorkAttempt>();
  const fallbackProjects = new Map<string, string>();
  const execute = (
    command: Parameters<ProjectWorkRepositoryShape["execute"]>[0],
  ): Effect.Effect<ProjectWorkCommandResult, ProjectWorkLeaseError | ProjectWorkRepositoryError> =>
    Option.match(repositoryOption, {
      onNone: () =>
        Effect.fail(
          new ProjectWorkLeaseError(
            "invalid-attempt-state",
            "A SQL repository is required for durable lease operations.",
          ),
        ),
      onSome: (repository) =>
        repository
          .execute(command)
          .pipe(
            Effect.mapError(
              (cause) => toLeaseError(cause) as ProjectWorkLeaseError | ProjectWorkRepositoryError,
            ),
          ),
    });
  const claim: ProjectWorkLeaseReactorShape["claim"] = (input) => {
    if (Option.isNone(repositoryOption)) {
      if (input.taskState !== undefined && input.taskState !== "ready")
        return Effect.fail(
          new ProjectWorkLeaseError("invalid-attempt-state", "Task is not ready."),
        );
      if (
        [...fallbackAttempts.values()].some(
          (attempt) =>
            attempt.taskId === input.taskId &&
            (attempt.state === "leased" || attempt.state === "running"),
        )
      )
        return Effect.fail(
          new ProjectWorkLeaseError("active-attempt", "Task already has an active attempt."),
        );
      if (fallbackAttempts.has(String(input.attemptId)))
        return Effect.fail(new ProjectWorkLeaseError("active-attempt", "Attempt already exists."));
      const attempt: ProjectWorkAttempt = {
        attemptId: input.attemptId,
        taskId: input.taskId,
        state: "leased",
        leaseToken: input.leaseToken,
        leasedUntil: input.leasedUntil,
        checkpointIds: [],
        revision: 0,
        ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      };
      fallbackAttempts.set(String(input.attemptId), attempt);
      fallbackProjects.set(String(input.attemptId), input.projectId);
      return Effect.succeed(attempt);
    }
    return execute({
      type: "project-work.task.claim",
      commandId: commandId("claim", String(input.attemptId), input.claimedAt),
      projectId: ProjectId.make(input.projectId),
      taskId: input.taskId,
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      leasedUntil: input.leasedUntil,
      claimedAt: input.claimedAt,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    }).pipe(
      Effect.map((result) =>
        result.state.attempts.find((attempt) => attempt.attemptId === input.attemptId)!,
      ),
    );
  };
  const renew: ProjectWorkLeaseReactorShape["renew"] = (input) => {
    if (Option.isNone(repositoryOption)) {
      const current = fallbackAttempts.get(String(input.attemptId));
      if (current === undefined)
        return Effect.fail(new ProjectWorkLeaseError("unknown-attempt", "Attempt does not exist."));
      try {
        assertProjectWorkLeaseFence(current, input.leaseToken, input.renewedAt);
      } catch (cause) {
        return Effect.fail(cause as ProjectWorkLeaseError);
      }
      const next: ProjectWorkAttempt = {
        ...current,
        state: "running",
        startedAt: current.startedAt ?? input.renewedAt,
        leasedUntil: input.leasedUntil,
        revision: current.revision + 1,
      };
      fallbackAttempts.set(String(input.attemptId), next);
      return Effect.succeed(next);
    }
    return execute({
      type: "project-work.attempt.renew",
      commandId: commandId("renew", String(input.attemptId), input.renewedAt),
      projectId: ProjectId.make(input.projectId),
      taskId: input.taskId,
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      leasedUntil: input.leasedUntil,
      renewedAt: input.renewedAt,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    }).pipe(
      Effect.map((result) =>
        result.state.attempts.find((attempt) => attempt.attemptId === input.attemptId)!,
      ),
    );
  };
  const checkpoint: ProjectWorkLeaseReactorShape["checkpoint"] = (input) => {
    if (Option.isNone(repositoryOption)) {
      const current = fallbackAttempts.get(String(input.attemptId));
      if (current === undefined)
        return Effect.fail(new ProjectWorkLeaseError("unknown-attempt", "Attempt does not exist."));
      try {
        assertProjectWorkLeaseFence(current, input.leaseToken, input.capturedAt);
      } catch (cause) {
        return Effect.fail(cause as ProjectWorkLeaseError);
      }
      if (
        [...fallbackAttempts.values()].some((attempt) =>
          attempt.checkpointIds.includes(input.checkpointId),
        )
      )
        return Effect.fail(
          new ProjectWorkLeaseError("duplicate-checkpoint", "Checkpoint already exists."),
        );
      fallbackAttempts.set(String(input.attemptId), {
        ...current,
        checkpointIds: [...current.checkpointIds, input.checkpointId],
        revision: current.revision + 1,
      });
      const checkpoint: ProjectWorkCheckpoint = {
        checkpointId: input.checkpointId,
        projectId: input.projectId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        capturedAt: input.capturedAt,
        revision: current.revision + 1,
        ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      };
      return Effect.succeed({
        eventId: EventId.make(`checkpoint:${input.checkpointId}:${input.capturedAt}`),
        projectId: input.projectId,
        revision: current.revision + 1,
        occurredAt: input.capturedAt,
        type: "project-work.attempt.checkpointed",
        checkpoint,
      } as ProjectWorkEvent);
    }
    return execute({
      type: "project-work.attempt.checkpoint",
      commandId: commandId("checkpoint", input.checkpointId, input.capturedAt),
      projectId: ProjectId.make(input.projectId),
      taskId: input.taskId,
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      checkpointId: input.checkpointId,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      capturedAt: input.capturedAt,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    }).pipe(Effect.map((result) => result.events[0]!));
  };
  const expire: ProjectWorkLeaseReactorShape["expire"] = ({ now, projectId }) => {
    if (Option.isNone(repositoryOption)) {
      const events: Array<ProjectWorkEvent> = [];
      for (const [id, attempt] of fallbackAttempts) {
        if (
          (projectId === undefined || fallbackProjects.get(id) === projectId) &&
          (attempt.state === "leased" || attempt.state === "running") &&
          projectWorkLeaseExpired(attempt, now)
        ) {
          const next: ProjectWorkAttempt = {
            ...attempt,
            state: "expired",
            failureKind: "lease-expired",
            failureReason: "Lease expired",
            endedAt: now,
            revision: attempt.revision + 1,
          };
          fallbackAttempts.set(id, next);
          events.push({
            eventId: EventId.make(`expire:${id}:${now}`),
            projectId: fallbackProjects.get(id) ?? projectId ?? "",
            revision: next.revision,
            occurredAt: now,
            type: "project-work.attempt.expired",
            taskId: next.taskId,
            attemptId: next.attemptId,
            reason: "Lease expired",
            expiredAt: now,
          });
        }
      }
      return Effect.succeed(events);
    }
    if (Option.isNone(sqlOption))
      return Effect.fail(
        new ProjectWorkLeaseError("invalid-attempt-state", "A SQL client is required."),
      );
    const sql = sqlOption.value;
    const batchSize = 100;
    const sweep = (
      after: { readonly leasedUntil: string; readonly attemptId: string } | undefined,
    ): Effect.Effect<ReadonlyArray<ProjectWorkEvent>, never> =>
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT attempt_id AS attemptId, project_id AS projectId, task_id AS taskId,
            leased_until AS leasedUntil
          FROM project_work_attempts
          WHERE state IN ('leased', 'running')
            AND leased_until IS NOT NULL AND leased_until <= ${now}
            ${projectId === undefined ? sql`` : sql`AND project_id = ${projectId}`}
            ${
              after === undefined
                ? sql``
                : sql`AND (leased_until > ${after.leasedUntil}
                    OR (leased_until = ${after.leasedUntil} AND attempt_id > ${after.attemptId}))`
            }
          ORDER BY leased_until ASC, attempt_id ASC
          LIMIT ${batchSize}
        `;
        const expired = yield* Effect.forEach(
          rows,
          (row) => {
            const attemptId = ProjectWorkAttemptId.make(String(row.attemptId));
            const deadline = String(row.leasedUntil);
            return execute({
              type: "project-work.attempt.expire",
              commandId: commandId("expire", String(attemptId), deadline),
              projectId: ProjectId.make(String(row.projectId)),
              taskId: ProjectWorkTaskId.make(String(row.taskId)),
              attemptId,
              reason: "Lease expired",
              // The transition is anchored to the deadline, so retries are deterministic.
              expiredAt: deadline,
            }).pipe(
              Effect.map((result) => result.events[0]),
              Effect.catch(() =>
                // A concurrent renewal, completion, takeover, or prior expiry is
                // expected. Reread the exact candidate before classifying it.
                sql<Record<string, unknown>>`
                  SELECT state, leased_until AS leasedUntil
                  FROM project_work_attempts WHERE attempt_id = ${attemptId} LIMIT 1
                `.pipe(
                  Effect.flatMap((current) => {
                    const value = current[0];
                    if (value === undefined) return Effect.succeed(undefined);
                    const state = String(value.state);
                    if (state !== "leased" && state !== "running") return Effect.succeed(undefined);
                    if (String(value.leasedUntil) !== deadline) return Effect.succeed(undefined);
                    return Effect.logWarning("project-work lease expiry candidate failed", {
                      attemptId,
                      deadline,
                    }).pipe(Effect.as(undefined));
                  }),
                  Effect.catchCause(() => Effect.succeed(undefined)),
                ),
              ),
            );
          },
          { concurrency: 8 },
        );
        const accepted = expired.filter((event): event is ProjectWorkEvent => event !== undefined);
        if (rows.length < batchSize) return accepted;
        const last = rows.at(-1)!;
        const rest = yield* sweep({
          leasedUntil: String(last.leasedUntil),
          attemptId: String(last.attemptId),
        });
        return [...accepted, ...rest];
      }).pipe(Effect.catchCause(() => Effect.succeed([])));
    return sweep(undefined);
  };
  const reclaim: ProjectWorkLeaseReactorShape["reclaim"] = (input) => {
    if (Option.isNone(repositoryOption)) {
      const previous = fallbackAttempts.get(String(input.previousAttemptId));
      if (previous === undefined)
        return Effect.fail(new ProjectWorkLeaseError("unknown-attempt", "Attempt does not exist."));
      if (previous.failureKind === "manual-triage")
        return Effect.fail(
          new ProjectWorkLeaseError("manual-triage", "Manual triage must be resolved."),
        );
      const attempt: ProjectWorkAttempt = {
        attemptId: input.attemptId,
        taskId: input.taskId,
        state: "leased",
        leaseToken: input.leaseToken,
        leasedUntil: input.leasedUntil,
        checkpointIds: [],
        revision: 0,
        ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      };
      fallbackAttempts.set(String(input.attemptId), attempt);
      fallbackProjects.set(String(input.attemptId), input.projectId);
      return Effect.succeed(attempt);
    }
    return execute({
      type: "project-work.attempt.reclaim",
      commandId: commandId("reclaim", String(input.attemptId), input.claimedAt),
      projectId: ProjectId.make(input.projectId),
      taskId: input.taskId,
      previousAttemptId: input.previousAttemptId,
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      leasedUntil: input.leasedUntil,
      claimedAt: input.claimedAt,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    }).pipe(
      Effect.map((result) =>
        result.state.attempts.find((attempt) => attempt.attemptId === input.attemptId)!,
      ),
    );
  };
  const takeover: ProjectWorkLeaseReactorShape["takeover"] = (input) => {
    if (Option.isNone(repositoryOption)) {
      if (!input.authorized)
        return Effect.fail(
          new ProjectWorkLeaseError("takeover-required", "Takeover requires authorization."),
        );
      const previous = fallbackAttempts.get(String(input.previousAttemptId));
      if (previous === undefined)
        return Effect.fail(new ProjectWorkLeaseError("unknown-attempt", "Attempt does not exist."));
      fallbackAttempts.set(String(input.previousAttemptId), {
        ...previous,
        state: "canceled",
        endedAt: input.claimedAt,
        revision: previous.revision + 1,
      });
      const attempt: ProjectWorkAttempt = {
        attemptId: input.attemptId,
        taskId: input.taskId,
        state: "leased",
        leaseToken: input.leaseToken,
        leasedUntil: input.leasedUntil,
        checkpointIds: [],
        revision: 0,
        ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      };
      fallbackAttempts.set(String(input.attemptId), attempt);
      fallbackProjects.set(String(input.attemptId), input.projectId);
      return Effect.succeed(attempt);
    }
    return execute({
      type: "project-work.attempt.takeover",
      commandId: commandId("takeover", String(input.attemptId), input.claimedAt),
      projectId: ProjectId.make(input.projectId),
      taskId: input.taskId,
      previousAttemptId: input.previousAttemptId,
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      leasedUntil: input.leasedUntil,
      claimedAt: input.claimedAt,
      authorized: input.authorized,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    }).pipe(
      Effect.map((result) =>
        result.state.attempts.find((attempt) => attempt.attemptId === input.attemptId)!,
      ),
    );
  };
  const get: ProjectWorkLeaseReactorShape["get"] = (attemptId) =>
    Option.match(repositoryOption, {
      onNone: () => Effect.succeed(fallbackAttempts.get(String(attemptId))),
      onSome: (repository) => repository.getAttempt(String(attemptId)),
    });
  return {
    claim,
    renew,
    renewLease: renew,
    checkpoint,
    checkpointAttempt: checkpoint,
    expire,
    expireLeases: expire,
    reclaim,
    reclaimAttempt: reclaim,
    takeover,
    takeoverAttempt: takeover,
    get,
  } satisfies ProjectWorkLeaseReactorShape;
});

export const ProjectWorkLeaseReactorLive = Layer.effect(
  ProjectWorkLeaseReactor,
  makeProjectWorkLeaseReactor,
);
export const make = makeProjectWorkLeaseReactor;
