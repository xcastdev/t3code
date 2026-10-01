import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  ProjectIssueCredentialSnapshot,
  type VerifiedIssueCredentialSnapshot,
} from "./ProjectIssueCredentialSnapshot.ts";
import {
  bindIssueRepositoryProject,
  readIssueRepositoryState,
  renameIssueRepository,
  rotateIssueRepositoryCredential,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { IssueSyncCredentialError, type IssueSyncCredential } from "./ProjectIssueSyncWorker.ts";
import { GitHubIssueClient } from "./github/GitHubIssueClient.ts";

export type IssueRepositoryRefreshReceipt = {
  readonly projectId: string;
  readonly status: "ready" | "unchanged" | "obsolete" | "unavailable" | "human-required";
  readonly reason?:
    | "authentication"
    | "transport"
    | "storage"
    | "identity-unavailable"
    | "repository-changed"
    | "account-mismatch"
    | "binding-conflict";
};
export interface ProjectIssueRepositoryManagerShape {
  readonly refresh: Effect.Effect<ReadonlyArray<IssueRepositoryRefreshReceipt>>;
  readonly resolveCredential: (
    state: IssueRepositoryState,
  ) => Effect.Effect<IssueSyncCredential | undefined, IssueSyncCredentialError>;
  readonly stop: Effect.Effect<void>;
}
export class ProjectIssueRepositoryManager extends Context.Service<
  ProjectIssueRepositoryManager,
  ProjectIssueRepositoryManagerShape
>()("t3/projectWork/ProjectIssueRepositoryManager") {}

const Canonical = Schema.String.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  ),
);
const isCanonical = Schema.is(Canonical);
const canAdvance = Schema.is(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
type ReconcileError =
  | IssueSyncCredentialError
  | Effect.Error<ReturnType<typeof readIssueRepositoryState>>
  | Effect.Error<ReturnType<typeof encodeJson>>;
const INITIAL_SINCE = "1970-01-01T00:00:00Z";
const cacheKey = (
  state: Pick<
    IssueRepositoryState,
    "host" | "repositoryNodeId" | "accountNodeId" | "credentialEpoch"
  >,
) =>
  `${state.host}\u0000${state.repositoryNodeId}\u0000${state.accountNodeId}\u0000${state.credentialEpoch}`;
interface ProjectFence {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
  readonly lifecycleRevision: number | null;
}
interface BindingFence {
  readonly host: string;
  readonly repositoryNodeId: string;
  readonly accountNodeId: string;
  readonly revision: number;
  readonly generation: number;
}

/** Startup and refresh share one scoped worker; every remote observation is fenced before mutation. */
export const make = Effect.fn("ProjectIssueRepositoryManager.make")(function* (
  options: { readonly onReady?: Effect.Effect<void> } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
    return yield* new IssueSyncCredentialError({ reason: "unavailable" });
  const identities = yield* RepositoryIdentityResolver;
  const snapshots = yield* ProjectIssueCredentialSnapshot;
  const github = yield* GitHubIssueClient;
  const crypto = yield* Crypto.Crypto;
  const queue = yield* Queue.dropping<void>(1);
  const cache = new Map<
    string,
    {
      readonly snapshot: VerifiedIssueCredentialSnapshot;
      readonly sourceEpoch: string;
      readonly project: ProjectFence;
      readonly binding: BindingFence;
    }
  >();
  let stopped = false;
  let after: string | undefined;
  let pending: Deferred.Deferred<ReadonlyArray<IssueRepositoryRefreshReceipt>> | undefined;

  const projectCurrent = Effect.fn("ProjectIssueRepositoryManager.projectCurrent")(function* (
    project: ProjectFence,
  ) {
    const rows =
      yield* sql<ProjectFence>`SELECT p.project_id AS projectId,p.workspace_root AS workspaceRoot,p.updated_at AS updatedAt,l.revision AS lifecycleRevision
      FROM projection_projects p LEFT JOIN project_lifecycle l ON l.project_id=p.project_id
      WHERE p.project_id=${project.projectId} AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state='active')`;
    const current = rows[0];
    return (
      current !== undefined &&
      current.workspaceRoot === project.workspaceRoot &&
      current.updatedAt === project.updatedAt &&
      current.lifecycleRevision === project.lifecycleRevision
    );
  });
  const bindings = Effect.fn("ProjectIssueRepositoryManager.bindings")(function* (
    projectId: string,
  ) {
    const active =
      yield* sql<BindingFence>`SELECT host,repository_node_id AS repositoryNodeId,account_node_id AS accountNodeId,revision,generation
      FROM project_issue_binding WHERE project_id=${projectId} AND status='active' ORDER BY host,repository_node_id LIMIT 2`;
    const historical =
      yield* sql`SELECT project_id FROM project_issue_binding WHERE project_id=${projectId} LIMIT 1`;
    return { active, historical: historical.length !== 0 };
  });
  const bindingCurrent = Effect.fn("ProjectIssueRepositoryManager.bindingCurrent")(function* (
    projectId: string,
    expected: BindingFence | undefined,
  ) {
    const current = yield* bindings(projectId);
    if (expected === undefined) return !current.historical;
    const row = current.active[0];
    return (
      current.active.length === 1 &&
      row !== undefined &&
      row.host === expected.host &&
      row.repositoryNodeId === expected.repositoryNodeId &&
      row.accountNodeId === expected.accountNodeId &&
      row.revision === expected.revision &&
      row.generation === expected.generation
    );
  });
  const invalidate = (state: Pick<IssueRepositoryState, "host" | "repositoryNodeId">) => {
    for (const [key, entry] of cache)
      if (
        entry.binding.host === state.host &&
        entry.binding.repositoryNodeId === state.repositoryNodeId
      )
        cache.delete(key);
  };

  const reconcilePage = Effect.fn("ProjectIssueRepositoryManager.reconcilePage")(
    function* () {
      const projects =
        yield* sql<ProjectFence>`SELECT p.project_id AS projectId,p.workspace_root AS workspaceRoot,p.updated_at AS updatedAt,l.revision AS lifecycleRevision
      FROM projection_projects p LEFT JOIN project_lifecycle l ON l.project_id=p.project_id
      WHERE p.deleted_at IS NULL AND (l.state IS NULL OR l.state='active')
      ${after === undefined ? sql`` : sql`AND p.project_id>${after}`}
      ORDER BY p.project_id LIMIT 32`;
      after = projects.length < 32 ? undefined : projects.at(-1)?.projectId;
      const receipts: Array<IssueRepositoryRefreshReceipt> = [];
      const verified = new Map<
        string,
        Effect.Success<ReturnType<typeof github.lookupRepository>>
      >();
      let changedReady = false;
      for (const project of projects) {
        if (stopped) break;
        let timedOut: Effect.Effect<IssueRepositoryRefreshReceipt, ReconcileError> = Effect.succeed(
          { projectId: project.projectId, status: "unavailable", reason: "transport" },
        );
        const reconcile = Effect.gen(function* (): Effect.fn.Return<
          IssueRepositoryRefreshReceipt,
          ReconcileError
        > {
          const captured = yield* sql.withTransaction(
            Effect.gen(function* () {
              const currentBindings = yield* bindings(project.projectId);
              const binding = currentBindings.active[0];
              const payload =
                binding === undefined
                  ? undefined
                  : (yield* sql<{
                      payload: string;
                    }>`SELECT payload_json AS payload FROM project_issue_repository WHERE host=${binding.host} AND repository_node_id=${binding.repositoryNodeId} AND length(payload_json)<=65536`)[0]
                      ?.payload;
              const previous =
                binding === undefined || payload === undefined
                  ? undefined
                  : yield* readIssueRepositoryState(sql, binding);
              return { currentBindings, binding, previous, payload };
            }),
          );
          const { currentBindings, binding, previous, payload } = captured;
          if (
            currentBindings.active.length > 1 ||
            (currentBindings.active.length === 0 && currentBindings.historical)
          )
            return {
              projectId: project.projectId,
              status: "human-required",
              reason: "binding-conflict",
            };
          if (
            binding !== undefined &&
            (previous === undefined ||
              previous.status === "detached" ||
              previous.accountNodeId !== binding.accountNodeId)
          )
            return {
              projectId: project.projectId,
              status: "human-required",
              reason: "binding-conflict",
            };
          const retained = previous === undefined ? undefined : cache.get(cacheKey(previous));
          if (previous !== undefined) invalidate(previous);
          const fail = Effect.fn("ProjectIssueRepositoryManager.unavailable")(function* (
            reason: NonNullable<IssueRepositoryRefreshReceipt["reason"]>,
            human = false,
          ): Effect.fn.Return<IssueRepositoryRefreshReceipt, ReconcileError> {
            if (stopped) return { projectId: project.projectId, status: "obsolete" };
            if (previous !== undefined && payload !== undefined) {
              const result = yield* sql.withTransaction(
                Effect.gen(function* () {
                  if (
                    stopped ||
                    !(yield* projectCurrent(project)) ||
                    !(yield* bindingCurrent(project.projectId, binding))
                  )
                    return false;
                  const rows = yield* sql<{
                    payload: string;
                  }>`SELECT payload_json AS payload FROM project_issue_repository WHERE host=${previous.host} AND repository_node_id=${previous.repositoryNodeId}`;
                  const detach =
                    reason === "repository-changed" || reason === "identity-unavailable";
                  if (
                    (detach &&
                      binding !== undefined &&
                      (!canAdvance(binding.revision) || !canAdvance(binding.generation))) ||
                    rows[0]?.payload !== payload ||
                    previous.revision === Number.MAX_SAFE_INTEGER ||
                    previous.authorityGeneration === Number.MAX_SAFE_INTEGER
                  )
                    return false;
                  const next: IssueRepositoryState = {
                    ...previous,
                    status: "unavailable",
                    error:
                      reason === "authentication" || reason === "account-mismatch"
                        ? "authentication"
                        : reason === "repository-changed" || reason === "identity-unavailable"
                          ? "invalid-page"
                          : "transport",
                    lease: null,
                    revision: previous.revision + 1,
                    authorityGeneration: previous.authorityGeneration + 1,
                  };
                  const encoded = yield* encodeJson(next);
                  if (stopped) return false;
                  yield* sql`UPDATE project_issue_repository SET payload_json=${encoded} WHERE host=${previous.host} AND repository_node_id=${previous.repositoryNodeId} AND payload_json=${payload}`;
                  if (detach && binding !== undefined)
                    yield* sql`UPDATE project_issue_binding SET status='detached',revision=${binding.revision + 1},generation=${binding.generation + 1} WHERE project_id=${project.projectId} AND host=${binding.host} AND repository_node_id=${binding.repositoryNodeId} AND status='active' AND revision=${binding.revision} AND generation=${binding.generation}`;
                  return true;
                }),
              );
              if (!result) return { projectId: project.projectId, status: "obsolete" };
            }
            return {
              projectId: project.projectId,
              status: human ? "human-required" : "unavailable",
              reason,
            };
          });
          timedOut = fail("transport");
          const identity = yield* identities.resolve(project.workspaceRoot, { refresh: true });
          if (
            identity === null ||
            identity.provider !== "github" ||
            !isCanonical(identity.canonicalKey)
          )
            return yield* fail("identity-unavailable", true);
          const slash = identity.canonicalKey.indexOf("/");
          const host = identity.canonicalKey.slice(0, slash);
          const name = identity.canonicalKey.slice(slash + 1);
          if (previous !== undefined && previous.host !== host)
            return yield* fail("repository-changed", true);
          if (previous !== undefined && previous.accountLogin === undefined)
            return yield* fail("account-mismatch", true);
          const credential = yield* snapshots
            .read({
              cwd: project.workspaceRoot,
              host,
              ...(previous === undefined
                ? {}
                : {
                    expectedAccountNodeId: previous.accountNodeId,
                    accountLogin: previous.accountLogin!,
                  }),
            })
            .pipe(Effect.result);
          if (credential._tag === "Failure")
            return yield* fail(
              credential.failure.reason === "account-mismatch"
                ? "account-mismatch"
                : credential.failure.reason === "unavailable"
                  ? "transport"
                  : "authentication",
              credential.failure.reason === "account-mismatch",
            );
          const snapshot = credential.success;
          const lookupKey = `${identity.canonicalKey}\u0000${snapshot.accountNodeId}\u0000${snapshot.credentialEpoch}`;
          const observed = yield* (
            verified.has(lookupKey)
              ? Effect.succeed(verified.get(lookupKey)!)
              : github
                  .lookupRepository({
                    cwd: snapshot.cwd,
                    account: {
                      host,
                      nodeId: snapshot.accountNodeId,
                      credentialFingerprint: snapshot.credentialEpoch,
                    },
                    repository: name,
                  })
                  .pipe(
                    Effect.provideService(GitHubCli.PinnedGitHubCredential, {
                      host,
                      token: snapshot.token,
                      credentialFingerprint: snapshot.credentialEpoch,
                    }),
                  )
          ).pipe(Effect.result);
          if (observed._tag === "Failure")
            return yield* fail(
              observed.failure.reason === "authentication" ||
                observed.failure.reason === "account-mismatch"
                ? "authentication"
                : "transport",
            );
          const remote = observed.success;
          verified.set(lookupKey, remote);
          if (remote.status !== "changed" || remote.data.host !== host)
            return yield* fail("transport");
          if (previous !== undefined && previous.repositoryNodeId !== remote.data.nodeId)
            return yield* fail("repository-changed", true);
          const key = { host, repositoryNodeId: remote.data.nodeId };
          const committed = yield* sql.withTransaction(
            Effect.gen(function* () {
              if (
                stopped ||
                !(yield* projectCurrent(project)) ||
                !(yield* bindingCurrent(project.projectId, binding))
              )
                return undefined;
              const size = (yield* sql<{
                size: number;
              }>`SELECT length(payload_json) AS size FROM project_issue_repository WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`)[0]
                ?.size;
              if (size !== undefined && size > 65536) return undefined;
              let state = yield* readIssueRepositoryState(sql, key);
              if (
                previous !== undefined &&
                (state === undefined ||
                  state.revision !== previous.revision ||
                  state.authorityGeneration !== previous.authorityGeneration ||
                  (yield* sql<{
                    payload: string;
                  }>`SELECT payload_json AS payload FROM project_issue_repository WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`)[0]
                    ?.payload !== payload)
              )
                return undefined;
              if (state !== undefined && state.accountNodeId !== snapshot.accountNodeId)
                return { mismatch: true } as const;
              if (stopped) return undefined;
              const known =
                retained ?? (state === undefined ? undefined : cache.get(cacheKey(state)));
              // Preserve a recovery epoch while the verified token is unchanged. Cache eviction
              // cannot reinstall a prior epoch and grant an old lease its credential again.
              let epoch =
                known?.sourceEpoch === snapshot.credentialEpoch
                  ? known.snapshot.credentialEpoch
                  : snapshot.credentialEpoch;
              if (
                state !== undefined &&
                ((state.error === "authentication" && state.credentialEpoch === epoch) ||
                  (known === undefined && state.credentialEpoch !== snapshot.credentialEpoch))
              )
                epoch = yield* crypto.randomUUIDv4.pipe(
                  Effect.mapError(() => new IssueSyncCredentialError({ reason: "unavailable" })),
                );
              if (stopped) return undefined;
              const currentCredential = { ...snapshot, credentialEpoch: epoch };
              let changed = false;
              let nextBinding = binding;
              if (state !== undefined && state.repositoryName !== remote.data.nameWithOwner) {
                state = yield* renameIssueRepository(sql, key, {
                  repositoryName: remote.data.nameWithOwner,
                  accountNodeId: snapshot.accountNodeId,
                  expectedRevision: state.revision,
                });
                changed = true;
              }
              if (state !== undefined && state.credentialEpoch !== epoch) {
                state = yield* rotateIssueRepositoryCredential(sql, key, {
                  accountNodeId: snapshot.accountNodeId,
                  accountLogin: snapshot.accountLogin,
                  credentialEpoch: epoch,
                  expectedRevision: state.revision,
                });
                changed = true;
              }
              if (binding === undefined) {
                const bound = yield* bindIssueRepositoryProject(sql, {
                  key,
                  projectId: project.projectId,
                  repositoryName: remote.data.nameWithOwner,
                  accountNodeId: snapshot.accountNodeId,
                  accountLogin: snapshot.accountLogin,
                  credentialEpoch: epoch,
                  since: INITIAL_SINCE,
                  expectedBindingRevision: null,
                });
                state = bound.state;
                nextBinding = { ...key, accountNodeId: snapshot.accountNodeId, ...bound.binding };
                changed = true;
              }
              if (
                state !== undefined &&
                binding !== undefined &&
                state.status === "unavailable" &&
                state.error !== "authentication"
              ) {
                const recovered = yield* bindIssueRepositoryProject(sql, {
                  key,
                  projectId: project.projectId,
                  repositoryName: remote.data.nameWithOwner,
                  accountNodeId: snapshot.accountNodeId,
                  accountLogin: snapshot.accountLogin,
                  credentialEpoch: epoch,
                  since: state.since,
                  expectedBindingRevision: binding.revision,
                });
                state = recovered.state;
                nextBinding = {
                  ...key,
                  accountNodeId: snapshot.accountNodeId,
                  ...recovered.binding,
                };
                changed = true;
              }
              if (state === undefined || nextBinding === undefined) return undefined;
              // A failed token must get a new epoch before it can regain read authority.
              if (state.status !== "ready" || state.error === "authentication") return undefined;
              return {
                mismatch: false,
                state,
                binding: nextBinding,
                changed,
                credential: currentCredential,
              } as const;
            }),
          );
          if (stopped || committed === undefined)
            return { projectId: project.projectId, status: "obsolete" };
          if (committed.mismatch)
            return {
              projectId: project.projectId,
              status: "human-required",
              reason: "account-mismatch",
            };
          invalidate(committed.state);
          if (cache.size === 32) cache.delete(cache.keys().next().value!);
          cache.set(cacheKey(committed.state), {
            snapshot: committed.credential,
            sourceEpoch: snapshot.credentialEpoch,
            project,
            binding: committed.binding,
          });
          changedReady ||= committed.changed;
          return {
            projectId: project.projectId,
            status: committed.changed ? "ready" : "unchanged",
          };
        });
        receipts.push(
          yield* reconcile.pipe(
            Effect.timeoutOrElse({
              duration: "55 seconds",
              orElse: () => timedOut,
            }),
            Effect.catch(() =>
              Effect.succeed({
                projectId: project.projectId,
                status: "unavailable",
                reason: "storage",
              } as const),
            ),
          ),
        );
      }
      if (!stopped && changedReady && options.onReady !== undefined) yield* options.onReady;
      return receipts;
    },
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<IssueRepositoryRefreshReceipt>)),
  );

  const worker = yield* Effect.forkScoped(
    Effect.gen(function* () {
      let nextAt = yield* Clock.currentTimeMillis;
      while (true) {
        if (stopped) return;
        const remaining = nextAt - (yield* Clock.currentTimeMillis);
        const periodic =
          remaining <= 0 ||
          (yield* Effect.raceFirst(
            Queue.take(queue).pipe(Effect.as(false)),
            Effect.sleep(remaining).pipe(Effect.as(true)),
          ));
        if (periodic) yield* Queue.poll(queue);
        const receipt = pending;
        const receipts = yield* reconcilePage();
        if (periodic) nextAt = (yield* Clock.currentTimeMillis) + 30_000;
        if (receipt !== undefined) {
          pending = undefined;
          yield* Deferred.succeed(receipt, receipts);
        }
      }
    }),
  );
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      stopped = true;
      cache.clear();
      yield* Fiber.interrupt(worker);
      yield* Queue.shutdown(queue);
      if (pending !== undefined) yield* Deferred.succeed(pending, []);
      pending = undefined;
    }),
  );
  yield* Effect.addFinalizer(() => stop);
  const refresh = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (stopped || Option.isSome(yield* Effect.serviceOption(sql.transactionService))) return [];
      if (pending === undefined) {
        pending = yield* Deferred.make<ReadonlyArray<IssueRepositoryRefreshReceipt>>();
        yield* Queue.offer(queue, undefined);
      }
      return yield* restore(Deferred.await(pending));
    }),
  );
  const resolveCredential = Effect.fn("ProjectIssueRepositoryManager.resolveCredential")(function* (
    state: IssueRepositoryState,
  ) {
    if (stopped) return undefined;
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new IssueSyncCredentialError({ reason: "unavailable" });
    const entry = cache.get(cacheKey(state));
    if (entry === undefined) return undefined;
    const valid = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* projectCurrent(entry.project)) ||
            !(yield* bindingCurrent(entry.project.projectId, entry.binding))
          )
            return false;
          const size = (yield* sql<{
            size: number;
          }>`SELECT length(payload_json) AS size FROM project_issue_repository WHERE host=${state.host} AND repository_node_id=${state.repositoryNodeId}`)[0]
            ?.size;
          if (size !== undefined && size > 65536) return false;
          const current = yield* readIssueRepositoryState(sql, state);
          return (
            current !== undefined &&
            current.status === "ready" &&
            current.error !== "authentication" &&
            current.accountNodeId === state.accountNodeId &&
            current.credentialEpoch === state.credentialEpoch
          );
        }),
      )
      .pipe(Effect.mapError(() => new IssueSyncCredentialError({ reason: "unavailable" })));
    if (stopped || !valid || cache.get(cacheKey(state)) !== entry) {
      cache.delete(cacheKey(state));
      return undefined;
    }
    return entry.snapshot;
  });
  return ProjectIssueRepositoryManager.of({ refresh, resolveCredential, stop });
});
