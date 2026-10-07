import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import * as IssueManager from "./ProjectIssueRepositoryManager.ts";
import * as IssueSync from "./ProjectIssueSyncWorker.ts";
import * as IssueComments from "./ProjectIssueComments.ts";
import * as IssueHumanBinding from "./ProjectIssueHumanBinding.ts";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import type { ProjectTeamExecutionError } from "./ProjectTeamExecution.ts";
import { makeProjectTeamExecutionReactor } from "./ProjectTeamExecutionReactor.ts";
import type { ProjectWorkPublicationRequest, ServerSettingsError } from "@t3tools/contracts";
import { ProjectWorkManagedMerge, makeProjectWorkManagedMerge } from "./ProjectWorkManagedMerge.ts";
import { PullRequestService, type PullRequestError } from "../pullRequest/PullRequestService.ts";
import * as Publication from "./ProjectWorkPullRequests.ts";
import * as PublicationLinks from "./ProjectWorkPublicationLinks.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  ProjectWorkPublicationAuthorization,
  makeProjectWorkPublicationAuthorization,
} from "./ProjectWorkPublicationAuthorization.ts";
import {
  ProjectWorkHumanPublication,
  makeProjectWorkHumanPublication,
} from "./ProjectWorkHumanPublicationRequest.ts";
import { readIssueRepositoryState } from "./ProjectIssueRepositoryState.ts";

import * as ProjectWorkEventBus from "./ProjectWorkEventBus.ts";
import * as ProjectWorkLeaseReactor from "./ProjectWorkLeaseReactor.ts";
import * as ProjectWorkRepository from "./ProjectWorkRepository.ts";
import * as ProjectWorkStream from "./ProjectWorkStream.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

const isPublicationError = Schema.is(Publication.PublicationError);

export interface ProjectTeamExecutionWorkerService {
  readonly sweep: () => Effect.Effect<{ readonly hasMore: boolean }, ProjectTeamExecutionError>;
  readonly stop: Effect.Effect<void>;
}

/** Existing generation ownership joins disable/shutdown; registry changes wake durable discovery. */
export const makeProjectTeamExecutionWorker = Effect.fn("makeProjectTeamExecutionWorker")(
  function* <R>(
    start: Effect.Effect<
      ProjectTeamExecutionWorkerService,
      ProjectTeamExecutionError,
      R | Scope.Scope
    >,
    ready: Effect.Effect<void> = Effect.void,
  ) {
    const pi = yield* ProjectTeamPiRuntime;
    const providerChanges = yield* pi.subscribeChanges;
    const reactor = yield* makeProjectTeamExecutionReactor({
      start: ready.pipe(
        Effect.andThen(start),
        Effect.map((service) => {
          const drain = Effect.gen(function* () {
            let hasMore = true;
            while (hasMore) hasMore = (yield* service.sweep()).hasMore;
          });
          return { ready: Effect.void, sweep: drain, stop: service.stop };
        }),
      ),
    });
    yield* Stream.runForEach(providerChanges, () =>
      reactor.drain().pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Project team availability wake failed", cause),
        ),
      ),
    ).pipe(Effect.forkScoped);
    return reactor;
  },
);

export const runProjectWorkLeaseWorker = (
  reactor: ProjectWorkLeaseReactor.ProjectWorkLeaseReactorShape,
  interval: Duration.Input = "30 seconds",
  onSweepComplete: (events: ReadonlyArray<ProjectWorkEvent>) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  Effect.suspend(() =>
    DateTime.now.pipe(
      Effect.flatMap((now) => reactor.expire({ now: DateTime.formatIso(now) })),
      Effect.catchCause((cause) =>
        Effect.logWarning("project-work lease sweep failed", cause).pipe(Effect.as([])),
      ),
      Effect.tap(onSweepComplete),
    ),
  ).pipe(Effect.repeat(Schedule.spaced(interval)));

/** One memoized repository and event bus shared by commands, streams, and workers. */
export const coreLayer = Layer.mergeAll(
  ProjectWorkEventBus.ProjectWorkEventBusLive,
  ProjectWorkRepository.ProjectWorkRepositoryLive.pipe(
    Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive),
  ),
  ProjectWorkStream.ProjectWorkStreamLive.pipe(
    Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive),
  ),
);

export const leaseLayer = ProjectWorkLeaseReactor.ProjectWorkLeaseReactorLive.pipe(
  Layer.provide(coreLayer),
);

/** Startup drain is non-blocking; the scoped fiber is interrupted with the server layer. */
export const leaseWorkerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ProjectWorkLeaseReactor.ProjectWorkLeaseReactor;
    yield* Effect.forkScoped(runProjectWorkLeaseWorker(reactor));
  }),
).pipe(Layer.provide(leaseLayer));

/** Use the same supplied core for command, lease and stream consumers. */
export const withCore = <ROut, E, RIn>(providedCore: Layer.Layer<ROut, E, RIn>) => {
  const leases = ProjectWorkLeaseReactor.ProjectWorkLeaseReactorLive.pipe(
    Layer.provideMerge(providedCore),
  );
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const reactor = yield* ProjectWorkLeaseReactor.ProjectWorkLeaseReactor;
      yield* Effect.forkScoped(runProjectWorkLeaseWorker(reactor));
    }),
  ).pipe(Layer.provideMerge(leases));
};

export type ProjectIssueRuntimeState = "disabled" | "ready" | "unavailable" | "stopped";
export class ProjectIssueRuntime extends Context.Service<
  ProjectIssueRuntime,
  {
    readonly ready: Effect.Effect<void>;
    readonly refresh: Effect.Effect<{
      readonly repositories: ReadonlyArray<IssueManager.IssueRepositoryRefreshReceipt>;
      readonly pages: ReadonlyArray<IssueSync.IssueSyncReceipt>;
    }>;
    readonly readComments: IssueComments.ProjectIssueComments["Service"]["read"];
    readonly bindRepository: IssueHumanBinding.ProjectIssueHumanBinding["Service"]["bind"];
    readonly resolvePublicationCredential: (
      request: ProjectWorkPublicationRequest,
    ) => Effect.Effect<Publication.PublicationCredential, Publication.PublicationError>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/projectWork/ProjectWorkRuntime/ProjectIssueRuntime") {}

/** Feature changes own the same child scope as repository refresh, page sync and comment readers. */
export const makeProjectIssueRuntime = Effect.fn("ProjectIssueRuntime.make")(function* (
  onState: (state: ProjectIssueRuntimeState) => Effect.Effect<void> = () => Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
    return yield* new IssueComments.IssueCommentsError({ reason: "unavailable" });
  const settings = yield* ServerSettingsService;
  const watcherScope = yield* Scope.make();
  const initialized = yield* Deferred.make<void>();
  let stopped = false;
  let child: Scope.Closeable | undefined;
  let active:
    | {
        readonly manager: IssueManager.ProjectIssueRepositoryManagerShape;
        readonly workerReady: Effect.Effect<IssueSync.ProjectIssueSyncWorkerShape | undefined>;
        readonly comments: IssueComments.ProjectIssueComments["Service"];
        readonly binding: IssueHumanBinding.ProjectIssueHumanBinding["Service"];
        readonly scope: Scope.Closeable;
      }
    | undefined;
  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      active = undefined;
      const closing = child;
      child = undefined;
      if (closing !== undefined) yield* Scope.close(closing, Exit.void);
    }),
  );
  // Register ownership before settings subscription construction can fail or be interrupted.
  yield* Effect.addFinalizer(() =>
    Scope.close(watcherScope, Exit.void).pipe(Effect.andThen(close)),
  );
  const changes = yield* settings.subscribeChanges.pipe(
    Effect.provideService(Scope.Scope, watcherScope),
  );
  const transition = Effect.fn("ProjectIssueRuntime.transition")(function* (enabled: boolean) {
    if (stopped) return;
    if (!enabled) {
      yield* close;
      yield* onState("disabled");
      return;
    }
    if (active !== undefined) return;
    child = yield* Scope.make();
    const serviceScope = child;
    const services = yield* Effect.gen(function* () {
      let worker: IssueSync.ProjectIssueSyncWorkerShape | undefined;
      let pendingWake = false;
      const manager = yield* IssueManager.make({
        onReady: Effect.suspend(() =>
          worker === undefined
            ? Effect.sync(() => {
                pendingWake = true;
              })
            : worker.wake,
        ),
      });
      const workerInitialized = yield* Deferred.make<
        IssueSync.ProjectIssueSyncWorkerShape | undefined
      >();
      yield* Effect.addFinalizer(() => Deferred.succeed(workerInitialized, undefined));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          // Verification must precede the sync claim: a claim changes the manager's payload fence.
          yield* manager.ready;
          worker = yield* IssueSync.make({
            prepareCredential: manager.resolveCredential,
            resolveCredential: manager.resolveCredential,
          });
          yield* Deferred.succeed(workerInitialized, worker);
          if (pendingWake) yield* worker.wake;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("project issue sync startup failed", cause),
          ),
          Effect.ensuring(Deferred.succeed(workerInitialized, undefined)),
        ),
      );
      const comments = yield* IssueComments.make({
        resolveCredential: (state) =>
          manager.ready.pipe(
            Effect.andThen(manager.resolveCredential(state)),
            Effect.mapError(
              () => new IssueComments.IssueCommentsError({ reason: "credential-mismatch" }),
            ),
            Effect.flatMap((credential) =>
              credential === undefined
                ? Effect.fail(
                    new IssueComments.IssueCommentsError({ reason: "credential-mismatch" }),
                  )
                : Effect.succeed({
                    cwd: credential.cwd,
                    host: credential.host,
                    accountNodeId: credential.accountNodeId,
                    credentialEpoch: credential.credentialEpoch,
                    token: credential.token,
                  }),
            ),
          ),
      });
      const binding = yield* IssueHumanBinding.make;
      return {
        manager,
        workerReady: Deferred.await(workerInitialized),
        comments,
        binding,
        scope: serviceScope,
      };
    }).pipe(Effect.provideService(Scope.Scope, child));
    if (stopped) {
      yield* close;
      return;
    }
    active = services;
    yield* onState("ready");
  });
  yield* Effect.forkScoped(
    Stream.concat(Stream.fromEffect(settings.getSettings), changes).pipe(
      Stream.runForEach((value) =>
        transition(value.projectWorkEnabled).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : close.pipe(Effect.andThen(onState("unavailable"))),
          ),
          Effect.ensuring(Deferred.succeed(initialized, undefined)),
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : close.pipe(Effect.andThen(onState("unavailable"))),
      ),
      Effect.ensuring(Deferred.succeed(initialized, undefined)),
    ),
  ).pipe(Effect.provideService(Scope.Scope, watcherScope));
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      if (stopped) return;
      stopped = true;
      yield* Scope.close(watcherScope, Exit.void);
      yield* close;
      yield* Deferred.succeed(initialized, undefined);
      yield* onState("stopped");
    }),
  );
  yield* Effect.addFinalizer(() => stop);
  const refresh = Effect.gen(function* () {
    yield* Deferred.await(initialized);
    const current = active;
    if (stopped || current === undefined) return { repositories: [], pages: [] };
    const worker = yield* current.workerReady;
    if (stopped || active !== current || worker === undefined)
      return { repositories: [], pages: [] };
    const repositories = yield* current.manager.refresh;
    if (stopped || active !== current) return { repositories: [], pages: [] };
    const pages = yield* worker.drain;
    return { repositories, pages };
  });
  const readComments: IssueComments.ProjectIssueComments["Service"]["read"] = (input) =>
    Effect.gen(function* () {
      yield* Deferred.await(initialized);
      const current = active;
      if (stopped || current === undefined)
        return yield* new IssueComments.IssueCommentsError({ reason: "unavailable" });
      return yield* current.comments.read(input);
    });
  const bindRepository: IssueHumanBinding.ProjectIssueHumanBinding["Service"]["bind"] = (
    input,
    authorization,
  ) =>
    Effect.gen(function* () {
      yield* Deferred.await(initialized);
      const current = active;
      if (stopped || current === undefined)
        return yield* new IssueHumanBinding.IssueHumanBindingError({ reason: "feature-disabled" });
      const receipt = yield* current.binding.bind(input, authorization);
      // Binding is already committed. Refresh is owned by the same feature scope and cannot retract its receipt.
      if (!stopped && active === current)
        yield* Effect.forkIn(
          current.manager.refresh.pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("project repository binding refresh failed", cause),
            ),
          ),
          current.scope,
        );
      return receipt;
    });
  const resolvePublicationCredential = Effect.fn(
    "ProjectIssueRuntime.resolvePublicationCredential",
  )(
    function* (request: ProjectWorkPublicationRequest) {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* new Publication.PublicationError({ reason: "credential-mismatch" });
      yield* Deferred.await(initialized);
      const current = active;
      if (stopped || current === undefined)
        return yield* new Publication.PublicationError({ reason: "credential-mismatch" });
      yield* current.manager.ready;
      const state = yield* readIssueRepositoryState(sql, {
        host: request.repository.host,
        repositoryNodeId: request.repository.nodeId,
      });
      if (
        state === undefined ||
        state.status !== "ready" ||
        state.repositoryName !== request.repository.nameWithOwner
      )
        return yield* new Publication.PublicationError({ reason: "credential-mismatch" });
      const bindings = yield* sql`
      SELECT binding.project_id FROM project_issue_binding binding
      JOIN projection_projects project ON project.project_id=binding.project_id
      LEFT JOIN project_lifecycle lifecycle ON lifecycle.project_id=project.project_id
      WHERE binding.project_id=${request.target.projectId} AND binding.host=${state.host}
        AND binding.repository_node_id=${state.repositoryNodeId} AND binding.account_node_id=${state.accountNodeId} AND binding.status='active'
        AND project.deleted_at IS NULL AND (lifecycle.state IS NULL OR lifecycle.state='active')
      LIMIT 1`;
      if (bindings.length !== 1)
        return yield* new Publication.PublicationError({ reason: "credential-mismatch" });
      const snapshot = yield* current.manager.resolveCredential(state);
      if (stopped || active !== current || snapshot === undefined)
        return yield* new Publication.PublicationError({ reason: "credential-mismatch" });
      return {
        cwd: snapshot.cwd,
        host: snapshot.host,
        repositoryNodeId: state.repositoryNodeId,
        headRepositoryNodeId: request.target.headRepositoryNodeId,
        credentialFingerprint: snapshot.credentialEpoch,
        token: snapshot.token,
      };
    },
    Effect.mapError((error) =>
      isPublicationError(error)
        ? error
        : new Publication.PublicationError({ reason: "credential-mismatch" }),
    ),
  );
  return ProjectIssueRuntime.of({
    ready: Deferred.await(initialized),
    refresh,
    readComments,
    bindRepository,
    resolvePublicationCredential,
    stop,
  });
});
export const issueRuntimeLayer = Layer.effect(ProjectIssueRuntime, makeProjectIssueRuntime());
export const issueCommentsLayer = Layer.effect(
  IssueComments.ProjectIssueComments,
  Effect.gen(function* () {
    const runtime = yield* ProjectIssueRuntime;
    return IssueComments.ProjectIssueComments.of({
      read: runtime.readComments,
      stop: runtime.stop,
    });
  }),
).pipe(Layer.provideMerge(issueRuntimeLayer));

/** The same service serializes live dispatch and recovery. Reflections never wake another read. */
export const runProjectWorkPublicationRecovery = Effect.fn("runProjectWorkPublicationRecovery")(
  function* (
    service: Pick<Publication.ProjectWorkPullRequests["Service"], "recoverAll" | "dispatchPending">,
    ready: Effect.Effect<void>,
  ) {
    const bus = yield* ProjectWorkEventBus.ProjectWorkEventBus;
    const changes = yield* bus.subscribe;
    const recover = service.recoverAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("project-work PR recovery failed", cause),
      ),
      Effect.asVoid,
    );
    const dispatchPending = service.dispatchPending().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("project-work pending PR dispatch failed", cause),
      ),
      Effect.asVoid,
    );
    yield* ready;
    yield* recover;
    yield* dispatchPending;
    yield* changes.pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "project-work.foundation.recorded" &&
          event.record.kind === "effect" &&
          event.record.effectKind === "publication" &&
          (event.record.status === "claimed" || event.record.status === "pending"),
      ),
      Stream.runForEach(({ event }) =>
        event.type === "project-work.foundation.recorded" &&
        event.record.kind === "effect" &&
        event.record.status === "pending"
          ? dispatchPending
          : recover,
      ),
    );
  },
);

export const publicationServicesLayer = Layer.effectContext(
  Effect.gen(function* () {
    const issues = yield* ProjectIssueRuntime;
    const identity = yield* ServerEnvironmentIdentity;
    const authorization = yield* makeProjectWorkPublicationAuthorization({
      environmentId: yield* identity.getEnvironmentId,
    });
    const publication = yield* Publication.make({
      resolveCredential: issues.resolvePublicationCredential,
      authorizePublication: authorization.assertCurrent,
    });
    const human = yield* makeProjectWorkHumanPublication.pipe(
      Effect.provideService(ProjectWorkPublicationAuthorization, authorization),
      Effect.provideService(Publication.ProjectWorkPullRequests, publication),
    );
    return Context.make(Publication.ProjectWorkPullRequests, publication).pipe(
      Context.add(ProjectWorkPublicationAuthorization, authorization),
      Context.add(ProjectWorkHumanPublication, human),
    );
  }),
);
export const publicationRecoveryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* Publication.ProjectWorkPullRequests;
    const issues = yield* ProjectIssueRuntime;
    yield* Effect.forkScoped(runProjectWorkPublicationRecovery(service, issues.ready));
  }),
);

/** Confirmed observations can restore thread links; uncertain results grant no link authority. */
export const runProjectWorkPublicationLinkRecovery = Effect.fn(
  "runProjectWorkPublicationLinkRecovery",
)(function* (
  service: Pick<PublicationLinks.ProjectWorkPublicationLinks["Service"], "recoverAll" | "link">,
  ready: Effect.Effect<void>,
  isEnabled: Effect.Effect<boolean, ServerSettingsError> = Effect.succeed(true),
  enabledChanges: Stream.Stream<unknown> = Stream.empty,
) {
  const bus = yield* ProjectWorkEventBus.ProjectWorkEventBus;
  const changes = yield* bus.subscribe;
  const guarded = <A>(operation: Effect.Effect<A, PublicationLinks.PublicationLinkError>) =>
    isEnabled.pipe(
      Effect.flatMap((enabled) => (enabled ? operation : Effect.succeed(undefined))),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("project-work PR link recovery failed", cause),
      ),
      Effect.asVoid,
    );
  const recover = guarded(
    service.recoverAll().pipe(
      Effect.tap((result) =>
        result.failed === 0
          ? Effect.void
          : Effect.logWarning("project-work PR links remain unavailable", {
              failed: result.failed,
            }),
      ),
    ),
  );
  yield* ready;
  yield* recover;
  const confirmed = changes.pipe(
    Stream.filterMap(({ event }) =>
      event.type === "project-work.foundation.recorded" &&
      event.record.kind === "effect" &&
      event.record.effectKind === "publication" &&
      event.record.status === "succeeded"
        ? Result.succeed({ kind: "confirmed" as const, operationId: event.record.effectId })
        : Result.fail(undefined),
    ),
  );
  const enabled = enabledChanges.pipe(Stream.map(() => ({ kind: "enabled" as const })));
  yield* Stream.merge(confirmed, enabled).pipe(
    Stream.runForEach((event) =>
      event.kind === "confirmed" ? guarded(service.link(event.operationId)) : recover,
    ),
  );
});

export const publicationLinksServicesLayer = Layer.effect(
  PublicationLinks.ProjectWorkPublicationLinks,
  PublicationLinks.make,
);
export const publicationLinksRecoveryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const links = yield* PublicationLinks.ProjectWorkPublicationLinks;
    const issues = yield* ProjectIssueRuntime;
    const settings = yield* ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    yield* Effect.forkScoped(
      runProjectWorkPublicationLinkRecovery(
        links,
        issues.ready,
        settings.getSettings.pipe(Effect.map((value) => value.projectWorkEnabled)),
        changes.pipe(Stream.filter((value) => value.projectWorkEnabled)),
      ),
    );
  }),
);

/** Subscribe before readiness: only committed human merge decisions wake the private journal. */
export const runProjectWorkManagedMergeRecovery = Effect.fn("runProjectWorkManagedMergeRecovery")(
  function* (
    service: Pick<ProjectWorkManagedMerge["Service"], "pending">,
    resume: (
      operationId: string,
      input: import("@t3tools/contracts").PullRequestActionInput,
    ) => Effect.Effect<void, PullRequestError>,
    ready: Effect.Effect<void>,
  ) {
    const bus = yield* ProjectWorkEventBus.ProjectWorkEventBus;
    const changes = yield* bus.subscribe;
    const drain = Effect.gen(function* () {
      let afterOperationId: string | undefined;
      while (true) {
        const rows = yield* service.pending(afterOperationId);
        for (const row of rows) {
          yield* resume(row.operationId, row.input).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Managed merge needs attention", cause),
            ),
          );
        }
        if (rows.length < 64) return;
        const last = rows.at(-1)?.operationId;
        if (last === undefined || (afterOperationId !== undefined && last <= afterOperationId))
          return yield* Effect.die("Managed merge journal page did not advance");
        afterOperationId = last;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Managed merge journal unavailable", cause),
      ),
    );
    yield* ready;
    yield* drain;
    yield* changes.pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "project-work.evidence.added" &&
          event.evidence.evidenceId.startsWith("managed-merge-permission:"),
      ),
      Stream.runForEach(() => drain),
    );
  },
);
export const managedMergeServicesLayer = Layer.effect(
  ProjectWorkManagedMerge,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironmentIdentity;
    return yield* makeProjectWorkManagedMerge({ environmentId: yield* identity.getEnvironmentId });
  }),
);
export const managedMergeRecoveryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* ProjectWorkManagedMerge;
    const pullRequests = yield* PullRequestService;
    const issues = yield* ProjectIssueRuntime;
    const resume = pullRequests.resumeManagedMerge;
    if (resume === undefined) return;
    yield* Effect.forkScoped(runProjectWorkManagedMergeRecovery(service, resume, issues.ready));
  }),
);
