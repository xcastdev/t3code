import { canonicalProjectWorkPayload, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { ProjectTeamRecoveryExecution } from "./ProjectTeamRecovery.ts";
import { ProjectTeamExecutionWake } from "./ProjectTeamExecutionReactor.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { makeProjectTeamExecutionHost } from "./ProjectTeamExecutionHost.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeProjectTeamAdmissionFacts,
  type ProjectTeamAdmissionFactsError,
} from "./ProjectTeamAdmissionFacts.ts";
import {
  prepareProjectTeamConfiguredAdmission,
  type ProjectTeamConfiguredAdmissionFacts,
} from "./ProjectTeamConfiguredAdmission.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamScheduler } from "./ProjectTeamScheduler.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";

export class ProjectTeamExecutionError extends Schema.TaggedError<ProjectTeamExecutionError>()(
  "ProjectTeamExecutionError",
  { reason: Schema.String },
) {}
const denied = (reason: string) => new ProjectTeamExecutionError({ reason });
const isExecutionError = Schema.is(ProjectTeamExecutionError);
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
type Admission = Effect.Success<ReturnType<typeof makeProjectTeamAdmissionFacts>>;
export interface ProjectTeamExecutionAdmission {
  readonly read: Admission["read"];
  readonly withCurrent: <A, E, R>(
    input: Parameters<Admission["read"]>[0],
    run: (
      facts: ProjectTeamConfiguredAdmissionFacts,
      revalidate: Effect.Effect<void, ProjectTeamAdmissionFactsError>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProjectTeamAdmissionFactsError, R>;
}
interface Options {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
  readonly managedWorktreesRoot: string;
  readonly protectedRoots: readonly string[];
  readonly launchPolicy: { readonly memoryBytes: number; readonly runtimeSeconds: number };
  /** Private staged gate. No client preference can supply the missing engineering verdicts. */
  readonly nativeAdmission: Effect.Effect<void, ProjectTeamExecutionError>;
  readonly admissionFacts?: ProjectTeamExecutionAdmission;
}
const projectRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ project_id: ProjectId })),
);
const taskRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ task_id: ProjectWorkTaskId })),
);
const dispatchRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ dispatch_id: Schema.String })),
);

/** The late server worker consumes this service after the ordinary provider layer exists. */
export const makeProjectTeamExecution = Effect.fn("makeProjectTeamExecution")(
  function* (supplied: Options) {
    const options = {
      ...supplied,
      protectedRoots: [...supplied.protectedRoots],
      launchPolicy: { ...supplied.launchPolicy },
    };
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const services = yield* Effect.context<
      | Effect.Services<ReturnType<typeof makeProjectTeamAdmissionFacts>>
      | Effect.Services<ReturnType<typeof makeProjectTeamExecutionHost>>
    >();
    const serial = yield* Semaphore.make(1);
    const executionScope = yield* Scope.make();
    const completed = yield* ProjectTeamExecutionWake;
    const admission = yield* (
      options.admissionFacts === undefined
        ? makeProjectTeamAdmissionFacts({ ...options, journal }).pipe(Effect.provide(services))
        : Effect.succeed(options.admissionFacts)
    ).pipe(Effect.cached);
    let stopped = false;
    const assertEnabled = Effect.gen(function* () {
      const current = yield* settings.getSettings;
      if (stopped || !current.projectWorkEnabled || !current.projectTeamExecutionEnabled)
        return yield* denied("Project team execution is disabled");
      yield* options.nativeAdmission;
    }).pipe(
      Effect.mapError((error) =>
        isExecutionError(error) ? error : denied("Project team execution is unavailable"),
      ),
    );
    const priorRequest = Effect.fn("ProjectTeamExecution.priorRequest")(function* (
      projectId: ProjectId,
      taskId: ProjectWorkTaskId,
    ) {
      const rows = yield* dispatchRows(
        yield* sql`SELECT dispatch_id FROM project_team_dispatch
      WHERE environment_id=${options.environmentId} AND project_id=${projectId} AND task_id=${taskId}
      AND stage <> 'settled' ORDER BY dispatch_id LIMIT 2`,
      );
      if (rows.length > 1) return yield* denied("Task has ambiguous retained dispatch ownership");
      return rows[0] === undefined
        ? undefined
        : (yield* journal.readRetained(rows[0].dispatch_id)).intent.request;
    });
    const scheduler = yield* makeProjectTeamScheduler({
      environmentId: options.environmentId,
      ports: {
        readProjectPage: (input) =>
          Effect.gen(function* () {
            const rows = yield* projectRows(
              yield* sql`SELECT DISTINCT project_id FROM project_team_limits
          WHERE status='configured' AND project_id > ${input.afterProjectId ?? ""}
          ORDER BY project_id LIMIT ${input.limit}`,
            );
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const state = yield* readCurrentState(sql, row.project_id);
                const policies = (state.foundationRecords ?? []).filter(
                  (r) => r.kind === "limits" && r.status === "configured",
                );
                const priorities = new Set(
                  policies.map((p) => (p.kind === "limits" ? (p.projectPriority ?? 0) : 0)),
                );
                if (priorities.size > 1)
                  return yield* denied("Configured project priorities disagree");
                return { projectId: row.project_id, priority: [...priorities][0] ?? 0 };
              }),
            );
          }),
        readProjectState: (input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const state = yield* readCurrentState(sql, input.projectId);
              const rows = yield* taskRows(
                yield* sql`SELECT task_id FROM project_work_tasks
          WHERE project_id=${input.projectId} AND task_id > ${input.afterTaskId ?? ""}
          ORDER BY task_id LIMIT ${input.limit}`,
              );
              const priorities = (state.foundationRecords ?? [])
                .filter((r) => r.kind === "limits" && r.status === "configured")
                .map((r) => (r.kind === "limits" ? (r.taskPriorities ?? []) : []));
              if (priorities.some((p) => !same(p, priorities[0] ?? [])))
                return yield* denied("Configured task priorities disagree");
              return {
                state,
                candidates: rows.map((row) => ({
                  taskId: row.task_id,
                  priority: priorities[0]?.find((p) => p.taskId === row.task_id)?.priority ?? 0,
                })),
              };
            }),
          ),
        prepareRequest: (input) =>
          Effect.gen(function* () {
            yield* assertEnabled;
            const prior = yield* priorRequest(ProjectId.make(input.state.projectId), input.taskId);
            if (prior !== undefined) return { _tag: "Prepared" as const, request: prior };
            const observed = yield* (yield* admission).read(input);
            return observed._tag === "Blocked"
              ? observed
              : prepareProjectTeamConfiguredAdmission({ ...input, facts: observed.facts });
          }),
        reserve: (request: ProjectTeamDispatchRequest) =>
          Effect.gen(function* () {
            yield* assertEnabled;
            const transition = request.claim.transition;
            if (transition?.kind !== "claim")
              return yield* denied("Prepared assignment has no claim");
            const prior = yield* priorRequest(
              transition.binding.projectId,
              transition.binding.taskId,
            );
            if (prior !== undefined) {
              if (!same(prior, request)) return yield* denied("Retained dispatch request changed");
              return yield* journal.inspect(prior.dispatchId);
            }
            const at = DateTime.make(request.claim.committedAt);
            if (Option.isNone(at)) return yield* denied("Prepared assignment timestamp is invalid");
            const state = yield* readCurrentState(sql, request.claim.projectId);
            return yield* (yield* admission).withCurrent(
              { state, taskId: transition.binding.taskId },
              (facts, revalidate) =>
                Effect.gen(function* () {
                  const regenerated = prepareProjectTeamConfiguredAdmission({
                    state,
                    taskId: transition.binding.taskId,
                    nowMs: DateTime.toEpochMillis(at.value),
                    facts,
                  });
                  if (regenerated._tag !== "Prepared" || !same(regenerated.request, request))
                    return yield* denied("Prepared resources changed before durable admission");
                  yield* revalidate;
                  return yield* journal.reserve(request, {
                    beforeDomainWrite: assertEnabled.pipe(
                      Effect.andThen(revalidate),
                      Effect.mapError(
                        () =>
                          new ProjectTeamDispatchJournalError({
                            reason: "Admission resources changed before domain writes",
                          }),
                      ),
                    ),
                  });
                }),
            );
          }),
      },
    });
    const schedule = Effect.fn("ProjectTeamExecution.schedule")(function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* denied("Execution must own its SQL transactions");
      const enabled = yield* assertEnabled.pipe(Effect.result);
      if (enabled._tag === "Failure")
        return {
          committed: [],
          blocked: [{ phase: "prepare" as const, reason: enabled.failure.reason }],
          projectsScanned: 0,
          tasksScanned: 0,
        };
      return yield* scheduler.sweep();
    });
    const host = yield* makeProjectTeamExecutionHost({
      ...options,
      assertEnabled: assertEnabled.pipe(
        Effect.mapError(
          () =>
            new ProjectTeamDispatchJournalError({
              reason: "Project team execution is unavailable",
            }),
        ),
      ),
    }).pipe(Effect.provide(services), Scope.provide(executionScope), Effect.cached);
    const sweep = () =>
      serial.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
            return yield* denied("Execution must own its SQL transactions");
          // Expected pending-verdict denial is a finite result, never a startup exception or retry loop.
          const admitted = yield* options.nativeAdmission.pipe(Effect.result);
          if (stopped || admitted._tag === "Failure")
            return {
              hasMore: false,
              committed: [],
              recovered: [],
              blocked: [
                {
                  reason: stopped
                    ? "Execution service stopped"
                    : admitted._tag === "Failure"
                      ? admitted.failure.reason
                      : "Unavailable",
                },
              ],
            };
          const recovery = yield* (yield* host).recover().pipe(
            Effect.provideService(ProjectTeamRecoveryExecution, {
              scope: executionScope,
              completed,
            }),
          );
          const scheduled = yield* schedule();
          return {
            hasMore:
              !recovery.wrapped ||
              ("hasMore" in scheduled && scheduled.hasMore === true) ||
              scheduled.committed.length > 0,
            committed: scheduled.committed,
            blocked: scheduled.blocked,
            recovered: recovery.items,
          };
        }).pipe(Effect.mapError(() => denied("Project team execution sweep is unavailable"))),
      );
    let hostStopped = false;
    const stop = yield* Effect.gen(function* () {
      if (stopped) return;
      stopped = true;
      // Closing a never-activated service must not construct/acquire its native dependencies.
      if (hostStopped) yield* (yield* host).stop;
    }).pipe(
      Effect.ensuring(Scope.close(executionScope, Exit.void)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Project team stop retained uncertainty", cause),
      ),
      Effect.uninterruptible,
      Effect.cached,
    );
    const runSweep = () =>
      Effect.gen(function* () {
        const admitted = yield* options.nativeAdmission.pipe(Effect.result);
        if (admitted._tag === "Success" && !stopped) hostStopped = true;
        return yield* sweep();
      });
    yield* Effect.addFinalizer(() => stop);
    return { schedule, sweep: runSweep, stop };
  },
  Effect.mapError((error) =>
    isExecutionError(error) ? error : denied("Project team execution service is unavailable"),
  ),
);
