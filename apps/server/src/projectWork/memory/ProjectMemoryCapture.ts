import * as Cause from "effect/Cause";
import { ProjectId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectTeamAuthorization } from "../ProjectTeamAuthorization.ts";
import {
  ProjectWorkContentGuard,
  isProjectWorkContentRejectedError,
} from "../ProjectWorkContentGuard.ts";
import { ProjectWorkEventBus } from "../ProjectWorkEventBus.ts";
import { ProjectWorkRepository, readCurrentState } from "../ProjectWorkRepository.ts";
import { makeProjectMemoryService, ProjectMemoryServiceError } from "./ProjectMemoryService.ts";

const selectors = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("project-work.comment.added"),
      comment: Schema.Struct({ commentId: Schema.String }),
    }),
    Schema.Struct({
      type: Schema.Literal("project-work.evidence.added"),
      evidence: Schema.Struct({ evidenceId: Schema.String }),
    }),
    Schema.Struct({
      type: Schema.Literal("project-work.decision.accepted"),
      decisionId: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("project-work.decision.superseded"),
      decisionId: Schema.String,
    }),
  ]),
);
const decodeSelector = Schema.decodeUnknownOption(selectors);
const deniedCapture = Schema.is(ProjectMemoryServiceError);
const relevant = (type: string) =>
  type === "project-work.comment.added" ||
  type === "project-work.evidence.added" ||
  type === "project-work.decision.accepted" ||
  type === "project-work.decision.superseded";

/** Retain committed project sources; extraction and physical indexing own separate workers. */
export const makeProjectMemoryCapture = Effect.fn("makeProjectMemoryCapture")(function* (options: {
  readonly environmentId: string;
  readonly ready?: Effect.Effect<void>;
}) {
  const sql = yield* SqlClient.SqlClient;
  if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
    return yield* new ProjectMemoryServiceError({
      reason: "Memory capture must own its SQL transactions",
    });
  const settings = yield* ServerSettingsService;
  const repository = yield* ProjectWorkRepository;
  const contentGuard = yield* ProjectWorkContentGuard;
  const authorization = yield* ProjectTeamAuthorization;
  const bus = yield* ProjectWorkEventBus;
  const scope = yield* Scope.make();
  const initialized = yield* Deferred.make<void, ProjectMemoryServiceError>();
  const observed = yield* TxRef.make({ cursor: 0, stopped: false });
  let stopped = false;
  let pending = false;
  let cursor = 0;
  let generation = 0;
  let failure: ProjectMemoryServiceError | undefined;
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      if (stopped) return;
      stopped = true;
      yield* TxRef.update(observed, (state) => ({ ...state, stopped: true }));
      yield* Deferred.succeed(initialized, undefined);
      yield* Scope.close(scope, Exit.void);
    }),
  );
  yield* Effect.addFinalizer(() => stop);

  const authorizeCapture = Effect.fn("ProjectMemoryCapture.authorize")(function* (
    projectId: string,
  ) {
    const current = yield* settings.getSettings;
    if (stopped || !current.projectWorkEnabled || !current.projectTeamExecutionEnabled)
      return yield* new ProjectMemoryServiceError({ reason: "Project memory capture is disabled" });
    const state = yield* readCurrentState(sql, projectId);
    if (
      !state.foundationRecords?.some(
        (record) =>
          record.kind === "limits" &&
          record.status === "configured" &&
          record.providerInstanceId !== undefined &&
          record.profileRecordIds !== undefined,
      )
    )
      return yield* new ProjectMemoryServiceError({ reason: "Project team is not configured" });
  });
  const service = makeProjectMemoryService({
    sql,
    repository,
    contentGuard,
    authorization,
    environmentId: options.environmentId,
    authorizeCapture,
  });

  const sweep = Effect.gen(function* () {
    yield* options.ready ?? Effect.void;
    const current = yield* settings.getSettings;
    if (stopped || !current.projectWorkEnabled || !current.projectTeamExecutionEnabled) return;
    const snapshot = (yield* sql<{
      cursor: number;
    }>`SELECT COALESCE(MAX(sequence),0) AS cursor FROM project_work_events`)[0]!.cursor;
    const initialGeneration = generation;
    let pageCursor = cursor;
    while (pageCursor < snapshot) {
      if (stopped || generation !== initialGeneration) break;
      const page = yield* sql<{ cursor: number; projectId: string; payload: string | null }>`
        SELECT sequence AS cursor, project_id AS projectId,
          CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json ELSE NULL END AS payload
        FROM project_work_events WHERE sequence>${pageCursor} AND sequence<=${snapshot}
          AND event_type IN ('project-work.comment.added','project-work.evidence.added',
            'project-work.decision.accepted','project-work.decision.superseded')
        ORDER BY sequence LIMIT 128`;
      for (const row of page) {
        if (stopped || generation !== initialGeneration) break;
        const decoded = decodeSelector(row.payload);
        if (decoded._tag === "None") continue;
        const event = decoded.value;
        if (event.type === "project-work.decision.superseded") {
          yield* service
            .supersedeDecision(row.projectId, event.decisionId)
            .pipe(
              Effect.catch((error) => (deniedCapture(error) ? Effect.void : Effect.fail(error))),
            );
          continue;
        }
        const selector =
          event.type === "project-work.comment.added"
            ? { kind: "comment", retainedId: event.comment.commentId }
            : event.type === "project-work.evidence.added"
              ? { kind: "evidence", retainedId: event.evidence.evidenceId }
              : {
                  kind: "decision",
                  retainedId: event.decisionId,
                };
        // Re-read attribution, lifecycle and content in the service's owning transaction.
        yield* service
          .captureRetained(ProjectId.make(row.projectId), selector)
          .pipe(
            Effect.catch((error) =>
              deniedCapture(error) || isProjectWorkContentRejectedError(error)
                ? Effect.void
                : Effect.fail(error),
            ),
          );
      }
      pageCursor = page.length < 128 ? snapshot : page[page.length - 1]!.cursor;
      if (generation === initialGeneration) cursor = pageCursor;
    }
  });
  const worker = yield* makeDrainableWorker((_item: void) =>
    Effect.gen(function* () {
      pending = false;
      failure = undefined;
      yield* sweep.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          failure = new ProjectMemoryServiceError({
            reason: "Project memory capture sweep failed",
          });
          return Deferred.fail(initialized, failure).pipe(
            Effect.andThen(Effect.logWarning(failure.reason)),
          );
        }),
      );
      yield* Deferred.succeed(initialized, undefined);
    }),
  ).pipe(Effect.provideService(Scope.Scope, scope));
  const wake = Effect.uninterruptible(
    Effect.gen(function* () {
      if (stopped || pending) return;
      pending = true;
      yield* worker.enqueue(undefined);
    }),
  );
  const reset = Effect.sync(() => {
    cursor = 0;
    generation += 1;
  });
  // Subscribe before catch-up so commits during the snapshot cannot be lost.
  const events = yield* bus.subscribe.pipe(Effect.provideService(Scope.Scope, scope));
  const changes = yield* settings.subscribeChanges.pipe(Effect.provideService(Scope.Scope, scope));
  const initialCursor = (yield* sql<{
    cursor: number;
  }>`SELECT COALESCE(MAX(sequence),0) AS cursor FROM project_work_events`)[0]!.cursor;
  yield* TxRef.update(observed, (state) => ({ ...state, cursor: initialCursor }));
  yield* events.pipe(
    Stream.runForEach(({ cursor: next, event }) =>
      Effect.gen(function* () {
        if (event.type === "project-work.foundation.recorded" && event.record.kind === "limits") {
          yield* reset;
          yield* wake;
        } else if (relevant(event.type)) yield* wake;
        yield* TxRef.update(observed, (state) => ({
          ...state,
          cursor: Math.max(state.cursor, next),
        }));
      }),
    ),
    Effect.forkScoped,
    Effect.provideService(Scope.Scope, scope),
  );
  yield* changes.pipe(
    Stream.runForEach(() => reset.pipe(Effect.andThen(wake))),
    Effect.forkScoped,
    Effect.provideService(Scope.Scope, scope),
  );
  yield* wake;
  const drain = (afterCursor = 0) =>
    Effect.gen(function* () {
      yield* TxRef.get(observed).pipe(
        Effect.tap((state) =>
          !state.stopped && state.cursor < afterCursor ? Effect.txRetry : Effect.void,
        ),
        Effect.tx,
      );
      if (stopped) return;
      yield* wake;
      yield* worker.drain;
      if (failure !== undefined) return yield* failure;
    });
  return { ready: Deferred.await(initialized), drain, stop };
});
