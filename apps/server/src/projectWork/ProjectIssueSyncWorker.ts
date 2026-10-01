import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { commitIssueRepositoryPage } from "./ProjectIssueIntakeService.ts";
import {
  claimIssueRepositoryRead,
  readIssueRepositoryState,
  recordIssueRepositoryReadFailure,
  type IssueRepositoryKey,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { GitHubIssueClient, type GitHubIssueClientError } from "./github/GitHubIssueClient.ts";
import { readCommittedIssuePage } from "./github/GitHubIssuePageStore.ts";
import { planPage, type IssueSyncRequest } from "./github/GitHubIssueSync.ts";

export interface IssueSyncCredential {
  readonly cwd: string;
  readonly host: string;
  readonly accountNodeId: string;
  readonly credentialEpoch: string;
  readonly token: Redacted.Redacted<string>;
}
export class IssueSyncCredentialError extends Schema.TaggedError<IssueSyncCredentialError>()(
  "IssueSyncCredentialError",
  { reason: Schema.Literals(["unavailable", "authentication"]) },
) {}
export interface IssueSyncWorkerOptions {
  /** Paginated verification can defer a row without allocating a lease or rejecting its account. */
  readonly prepareCredential?: (
    state: IssueRepositoryState,
  ) => Effect.Effect<IssueSyncCredential | undefined, IssueSyncCredentialError>;
  readonly resolveCredential: (
    state: IssueRepositoryState,
  ) => Effect.Effect<IssueSyncCredential | undefined, IssueSyncCredentialError>;
}
export type IssueSyncReceipt =
  | { readonly status: "no-claim" | "obsolete"; readonly key: IssueRepositoryKey }
  | {
      readonly status: "committed";
      readonly key: IssueRepositoryKey;
      readonly page: number;
      readonly nextPage: number | null;
    }
  | {
      readonly status: "failure";
      readonly key: IssueRepositoryKey;
      readonly reason: NonNullable<IssueRepositoryState["error"]> | "storage";
      readonly retryAt?: number;
    };
export interface ProjectIssueSyncWorkerShape {
  readonly readOnce: (key: IssueRepositoryKey) => Effect.Effect<IssueSyncReceipt>;
  readonly wake: Effect.Effect<void>;
  readonly drain: Effect.Effect<ReadonlyArray<IssueSyncReceipt>>;
  readonly stop: Effect.Effect<void>;
}
export class ProjectIssueSyncWorker extends Context.Service<
  ProjectIssueSyncWorker,
  ProjectIssueSyncWorkerShape
>()("t3/projectWork/ProjectIssueSyncWorker") {}

const seconds = (value: DateTime.Utc) => DateTime.formatIso(value).replace(/\.\d{3}Z$/u, "Z");
const identity = (key: IssueRepositoryKey) => `${key.host}\u0000${key.repositoryNodeId}`;
const requestFromClaim = (state: IssueRepositoryState, leaseId: string): IssueSyncRequest => ({
  repository: {
    host: state.host,
    nodeId: state.repositoryNodeId,
    nameWithOwner: state.repositoryName,
  },
  account: {
    host: state.host,
    nodeId: state.accountNodeId,
    credentialFingerprint: state.credentialEpoch,
  },
  query: {
    since: state.since,
    pageSize: state.pageSize,
    state: "all",
    sort: "updated",
    direction: "asc",
  },
  page: state.nextPage,
  generation: state.authorityGeneration,
  leaseId,
});
const clientFailure = (
  error: GitHubIssueClientError,
): NonNullable<IssueRepositoryState["error"]> => {
  switch (error.reason) {
    case "rate-limited":
    case "rate-paused":
      return "rate-limit";
    case "authentication":
    case "credential-missing":
    case "credential-mismatch":
    case "account-mismatch":
      return "authentication";
    case "unavailable":
    case "command-failed":
      return "transport";
    default:
      return "invalid-page";
  }
};

type Work =
  | {
      readonly kind: "read";
      readonly key: IssueRepositoryKey;
      readonly receipt: Deferred.Deferred<IssueSyncReceipt>;
    }
  | {
      readonly kind: "drain";
      readonly receipt?: Deferred.Deferred<ReadonlyArray<IssueSyncReceipt>>;
    };

/** One joined, scoped worker. SQL remains the authority for every page and restart. */
export const make = Effect.fn("ProjectIssueSyncWorker.make")(function* (
  options: IssueSyncWorkerOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const client = yield* GitHubIssueClient;
  const owner = `issue-sync:${yield* Random.nextInt}:${yield* Random.nextInt}`;
  const queue = yield* Queue.dropping<Work>(32);
  const waiting = new Set<Work>();
  const reading = new Set<string>();
  let stopped = false;
  let wakePending = false;
  let sequence = 0;
  let after: IssueRepositoryKey | undefined;

  const readPage = Effect.fn("ProjectIssueSyncWorker.readPage")(function* (
    key: IssueRepositoryKey,
  ): Effect.fn.Return<IssueSyncReceipt> {
    if (stopped) return { status: "obsolete", key };
    let preparedCredential: IssueSyncCredential | undefined;
    let expectedRevision: number | undefined;
    if (options.prepareCredential !== undefined) {
      const candidate = yield* readIssueRepositoryState(sql, key).pipe(Effect.result);
      if (candidate._tag === "Failure") return { status: "failure", key, reason: "storage" };
      if (candidate.success === undefined || candidate.success.status !== "ready")
        return { status: "no-claim", key };
      const prepared = yield* options.prepareCredential(candidate.success).pipe(Effect.result);
      if (
        prepared._tag === "Failure" ||
        prepared.success === undefined ||
        prepared.success.host !== candidate.success.host ||
        prepared.success.accountNodeId !== candidate.success.accountNodeId ||
        prepared.success.credentialEpoch !== candidate.success.credentialEpoch
      )
        return { status: "no-claim", key };
      preparedCredential = prepared.success;
      expectedRevision = candidate.success.revision;
    }
    if (stopped) return { status: "obsolete", key };
    const claimed = yield* claimIssueRepositoryRead(sql, key, {
      leaseId: `${owner}:${++sequence}`,
      durationMs: 60_000,
      sweepStartedAt: seconds(yield* DateTime.now),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }).pipe(Effect.result);
    if (claimed._tag === "Failure") return { status: "failure", key, reason: "storage" };
    const state = claimed.success;
    if (state?.lease === undefined || state.lease === null) return { status: "no-claim", key };
    const lease = state.lease;
    const request = requestFromClaim(state, lease.id);
    const failed = Effect.fn("ProjectIssueSyncWorker.failed")(function* (
      reason: NonNullable<IssueRepositoryState["error"]>,
      retry?: number,
    ): Effect.fn.Return<IssueSyncReceipt> {
      if (stopped) return { status: "obsolete", key };
      const now = yield* Clock.currentTimeMillis;
      const minimum = now + (reason === "rate-limit" ? 60_000 : 30_000);
      const retryAt = Math.min(
        now + 3_600_000,
        Math.max(minimum, Number.isFinite(retry) ? retry! : minimum),
      );
      const recorded = yield* recordIssueRepositoryReadFailure(sql, key, lease, {
        error: reason,
        retryAt,
      }).pipe(Effect.result);
      if (recorded._tag === "Failure") return { status: "failure", key, reason: "storage" };
      return recorded.success
        ? { status: "failure", key, reason, retryAt }
        : { status: "obsolete", key };
    });
    const attempt = Effect.gen(function* () {
      const credential =
        preparedCredential ??
        (yield* options
          .resolveCredential(state)
          .pipe(Effect.catch(() => Effect.succeed(undefined))));
      if (
        credential === undefined ||
        credential.host !== state.host ||
        credential.accountNodeId !== state.accountNodeId ||
        credential.credentialEpoch !== state.credentialEpoch
      )
        return yield* failed("authentication");
      const prior = yield* readCommittedIssuePage(sql, request);
      const plan = planPage({
        request,
        currentFence: request,
        ...(prior === undefined ? {} : { priorCommittedSnapshot: prior }),
      });
      if (plan.status !== "ready") return yield* failed("invalid-page");
      const response = yield* client
        .readIssuesPage({
          cwd: credential.cwd,
          account: request.account,
          repository: request.repository,
          since: request.query.since,
          pageSize: request.query.pageSize,
          page: request.page,
          ...(plan.etag === undefined ? {} : { etag: plan.etag }),
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: credential.host,
            token: credential.token,
            credentialFingerprint: credential.credentialEpoch,
          }),
          Effect.result,
        );
      if (stopped) return { status: "obsolete", key } as const;
      if (response._tag === "Failure")
        return yield* failed(clientFailure(response.failure), response.failure.retryAt);
      if (response.success.repository.nameWithOwner !== request.repository.nameWithOwner)
        return yield* failed("invalid-page");
      const result = yield* commitIssueRepositoryPage(sql, {
        request,
        lease,
        response: response.success,
        nextSweepDelayMs: 60_000,
        ...(plan.etag === undefined ? {} : { sentEtag: plan.etag }),
      }).pipe(
        Effect.provideService(ProjectWorkRepository, repository),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return result.accepted && result.page !== undefined
        ? ({
            status: "committed",
            key,
            page: request.page,
            nextPage: result.page.nextPage,
          } as const)
        : ({ status: "obsolete", key } as const);
    });
    return yield* attempt.pipe(
      Effect.timeoutOrElse({ duration: "55 seconds", orElse: () => failed("transport") }),
      Effect.catchTag("IssueIntakeCommitError", () => failed("invalid-page")),
      Effect.catchTag("IssuePageStoreError", () => failed("invalid-page")),
      Effect.catchTag("IssueRepositoryStateError", () =>
        Effect.succeed({ status: "obsolete", key } as const),
      ),
      Effect.catch(() => Effect.succeed({ status: "failure", key, reason: "storage" } as const)),
    );
  });

  const runDrain = Effect.fn("ProjectIssueSyncWorker.runDrain")(
    function* () {
      const keys = yield* sql<{
        host: string;
        repositoryNodeId: string;
      }>`SELECT host,repository_node_id AS repositoryNodeId FROM project_issue_repository
      ${after === undefined ? sql`` : sql`WHERE (host,repository_node_id)>(${after.host},${after.repositoryNodeId})`}
      ORDER BY host,repository_node_id LIMIT 32`;
      after = keys.length < 32 ? undefined : keys.at(-1);
      const receipts: Array<IssueSyncReceipt> = [];
      for (const key of keys) {
        if (stopped) break;
        receipts.push(yield* readPage(key));
      }
      return receipts;
    },
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<IssueSyncReceipt>)),
  );

  const worker = yield* Effect.forkScoped(
    Effect.gen(function* () {
      const periodicDrain: Work = { kind: "drain" };
      let nextDrainAt = (yield* Clock.currentTimeMillis) + 30_000;
      while (true) {
        if (stopped) return;
        const remaining = nextDrainAt - (yield* Clock.currentTimeMillis);
        // Queue traffic cannot postpone an automatic drain once its deadline arrives.
        const work: Work =
          remaining <= 0
            ? periodicDrain
            : yield* Effect.raceFirst(
                Queue.take(queue),
                Effect.sleep(remaining).pipe(Effect.as(periodicDrain)),
              );
        if (work.kind === "read") {
          const receipt = yield* readPage(work.key);
          reading.delete(identity(work.key));
          waiting.delete(work);
          yield* Deferred.succeed(work.receipt, receipt);
        } else {
          const receipts = yield* runDrain();
          if (work === periodicDrain) nextDrainAt = (yield* Clock.currentTimeMillis) + 30_000;
          if (work.receipt !== undefined) yield* Deferred.succeed(work.receipt, receipts);
          wakePending = false;
        }
        waiting.delete(work);
      }
    }),
  );
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      stopped = true;
      yield* Fiber.interrupt(worker);
      yield* Queue.shutdown(queue);
      for (const work of waiting) {
        if (work.kind === "read")
          yield* Deferred.succeed(work.receipt, { status: "obsolete", key: work.key });
        else if (work.receipt !== undefined) yield* Deferred.succeed(work.receipt, []);
      }
      waiting.clear();
      reading.clear();
    }),
  );
  yield* Effect.addFinalizer(() => stop);
  const readOnce = Effect.fn("ProjectIssueSyncWorker.readOnce")(function* (
    key: IssueRepositoryKey,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (stopped) return { status: "obsolete", key } as const;
        const id = identity(key);
        if (reading.has(id)) return { status: "no-claim", key } as const;
        const receipt = yield* Deferred.make<IssueSyncReceipt>();
        const work: Work = { kind: "read", key: { ...key }, receipt };
        reading.add(id);
        waiting.add(work);
        if (!(yield* Queue.offer(queue, work))) {
          waiting.delete(work);
          reading.delete(id);
          return { status: "no-claim", key } as const;
        }
        return yield* restore(Deferred.await(receipt));
      }),
    );
  });
  const drain = Effect.gen(function* () {
    if (stopped) return [];
    const receipt = yield* Deferred.make<ReadonlyArray<IssueSyncReceipt>>();
    const work: Work = { kind: "drain", receipt };
    waiting.add(work);
    if (!(yield* Queue.offer(queue, work))) {
      waiting.delete(work);
      return [];
    }
    return yield* Deferred.await(receipt);
  });
  const wake = Effect.gen(function* () {
    if (stopped || wakePending) return;
    wakePending = true;
    if (!(yield* Queue.offer(queue, { kind: "drain" }))) wakePending = false;
  });
  return ProjectIssueSyncWorker.of({ readOnce, drain, wake, stop });
});
