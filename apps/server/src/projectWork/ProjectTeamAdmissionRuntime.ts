import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeProjectTeamAdmissionFacts,
  ProjectTeamAdmissionFactsError,
} from "./ProjectTeamAdmissionFacts.ts";
import { prepareProjectTeamConfiguredAdmission } from "./ProjectTeamConfiguredAdmission.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import {
  makeProjectTeamScheduler,
  type ProjectTeamSchedulerPorts,
} from "./ProjectTeamScheduler.ts";
import { makeProjectTeamSchedulingView } from "./ProjectTeamSchedulingView.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";

export class ProjectTeamAdmissionRuntimeError extends Schema.TaggedError<ProjectTeamAdmissionRuntimeError>()(
  "ProjectTeamAdmissionRuntimeError",
  { reason: Schema.String },
) {}
const isKnownDenial = Schema.is(
  Schema.Union([
    ProjectTeamAdmissionRuntimeError,
    ProjectTeamAdmissionFactsError,
    ProjectTeamDispatchJournalError,
  ]),
);
const denied = (reason: string) => new ProjectTeamAdmissionRuntimeError({ reason });
class AdmissionCommit extends Context.Service<
  AdmissionCommit,
  {
    readonly request: ProjectTeamDispatchRequest;
    readonly before: Effect.Effect<void, ProjectTeamAdmissionRuntimeError>;
    readonly after: Effect.Effect<void, ProjectTeamAdmissionRuntimeError>;
  }
>()("t3/projectWork/ProjectTeamAdmissionRuntime/AdmissionCommit") {}
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);

/** The scheduler proposes identities; only this captured transaction reserves them.
 * No workspace, process or model operation is allocated by admission. */
export const makeProjectTeamAdmissionRuntime = Effect.fn("makeProjectTeamAdmissionRuntime")(
  function* (supplied: Omit<Parameters<typeof makeProjectTeamAdmissionFacts>[0], "journal">) {
    const options = Object.freeze({
      ...supplied,
      protectedRoots: Object.freeze([...supplied.protectedRoots]),
    });
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const live = new WeakSet<object>();
    const journal = yield* makeProjectTeamDispatchJournal({
      ...options,
      verifyAdmission: (input) =>
        Effect.gen(function* () {
          const loan = yield* Effect.serviceOption(AdmissionCommit);
          if (
            Option.isNone(loan) ||
            !live.has(loan.value) ||
            !same(loan.value.request, input.request)
          )
            return yield* denied("Reservation has no original live resource loan");
          yield* input.stage === "before" ? loan.value.before : loan.value.after;
        }).pipe(
          Effect.mapError(
            () =>
              new ProjectTeamDispatchJournalError({
                reason: "Current admission resource loan failed",
              }),
          ),
        ),
    });
    const facts = yield* makeProjectTeamAdmissionFacts({ ...options, journal });
    const view = yield* makeProjectTeamSchedulingView();
    const enabled = Effect.gen(function* () {
      const ambient = Context.getOption(yield* Effect.context<never>(), SqlClient.SqlClient);
      if (Option.isSome(ambient) && ambient.value !== sql)
        return yield* denied("Admission belongs to another SQL client");
      const current = yield* settings.getSettings;
      if (!current.projectWorkEnabled || !current.projectTeamExecutionEnabled)
        return yield* denied("Project team execution is disabled");
    });
    const ports: ProjectTeamSchedulerPorts<ProjectTeamAdmissionRuntimeError> = {
      readProjectPage: (input) =>
        view
          .readProjectPage(input)
          .pipe(Effect.mapError(() => denied("Project selection is unavailable"))),
      readProjectState: (input) =>
        view
          .readProjectState(input)
          .pipe(Effect.mapError(() => denied("Current project selection is unavailable"))),
      prepareRequest: (input) =>
        Effect.gen(function* () {
          yield* enabled;
          const measured = yield* facts.read(input);
          if (measured._tag === "Blocked") return measured;
          return prepareProjectTeamConfiguredAdmission({ ...input, facts: measured.facts });
        }).pipe(Effect.mapError(() => denied("Current admission facts are unavailable"))),
      reserve: (request) =>
        Effect.gen(function* () {
          yield* enabled;
          const binding =
            request.claim.transition?.kind === "claim"
              ? request.claim.transition.binding
              : undefined;
          if (!binding) return yield* denied("Original configured assignment is missing");
          // A lost response must return its original retained request, never regenerate
          // timestamps or consume the one-shot human authorization a second time.
          const prior = yield* sql`SELECT dispatch_id FROM project_team_dispatch
        WHERE dispatch_id=${request.dispatchId} AND environment_id=${options.environmentId}`;
          if (prior.length > 0) {
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* enabled;
                const retained = yield* journal.inspect(request.dispatchId);
                if (!same(retained.intent.request, request))
                  return yield* denied("Retained admission has different content");
                return retained;
              }),
            );
          }
          const state = yield* readCurrentState(sql, request.claim.projectId);
          return yield* facts.withCurrent(
            { state, taskId: binding.taskId },
            (measured, revalidate, resources) =>
              Effect.gen(function* () {
                yield* enabled;
                const rebuilt = prepareProjectTeamConfiguredAdmission({
                  state,
                  taskId: binding.taskId,
                  nowMs: Date.parse(request.claim.committedAt),
                  facts: measured,
                });
                if (rebuilt._tag !== "Prepared" || !same(rebuilt.request, request))
                  return yield* denied("Prepared assignment changed before reservation");
                const loan = Object.freeze({
                  request,
                  before: enabled.pipe(
                    Effect.andThen(revalidate),
                    Effect.mapError(() => denied("Current admission changed before reservation")),
                  ),
                  after: resources.pipe(
                    Effect.andThen(enabled),
                    Effect.mapError(() => denied("Admission resources changed before commit")),
                  ),
                });
                live.add(loan);
                return yield* journal.reserve(request).pipe(
                  Effect.provideService(AdmissionCommit, loan),
                  Effect.ensuring(
                    Effect.sync(() => {
                      live.delete(loan);
                    }),
                  ),
                );
              }),
          );
        }).pipe(
          Effect.mapError((error) =>
            denied(
              isKnownDenial(error)
                ? error.reason
                : error instanceof ProjectWorkPolicyError
                  ? error.message
                  : "Configured reservation was not committed",
            ),
          ),
        ),
    };
    const scheduler = yield* makeProjectTeamScheduler({
      environmentId: options.environmentId,
      ports,
    });
    return { sweep: scheduler.sweep };
  },
);
