import {
  IssueSearchInput,
  IssueSearchResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "@t3tools/contracts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";

type IssueSearchError = PullRequestOperationError | PullRequestUnavailableError;

export class IssueSearchService extends Context.Service<
  IssueSearchService,
  {
    readonly search: (
      input: IssueSearchInput,
    ) => Effect.Effect<IssueSearchResult, IssueSearchError>;
  }
>()("t3/sourceControl/IssueSearchService") {}

const decodeInput = Schema.decodeUnknownEffect(IssueSearchInput);
const decodeResult = Schema.decodeUnknownEffect(IssueSearchResult);

const make = Effect.gen(function* () {
  const projects = yield* ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const api = yield* GitHubIssueApi.GitHubIssueApi;
  const search = Effect.fn("IssueSearchService.search")(function* (raw: IssueSearchInput) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "issues.search",
            detail: "Invalid issue search request.",
            cause,
          }),
      ),
    );
    const project = yield* projects.get(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "issues.search",
            detail: "The project could not be read.",
            cause,
          }),
      ),
    );
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new PullRequestOperationError({
        operation: "issues.search",
        detail: "The project is unavailable.",
        reason: "not-found",
      });
    const cwd = project.value.workspaceRoot;
    const identity = yield* identities.resolve(cwd, { refresh: true });
    const match = identity?.canonicalKey.match(/^([^/]+)\/([^/]+\/[^/]+)$/u);
    if (identity?.provider !== "github" || !match)
      return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
    const host = match[1]!;
    const entries = yield* Effect.gen(function* () {
      const account = yield* api.getAccount({ cwd, host });
      const repository = yield* api.lookupRepository({
        cwd,
        account,
        repository: identity.displayName ?? match[2]!,
      });
      if (
        repository.status !== "changed" ||
        `${repository.data.host}/${repository.data.nameWithOwner}`.toLowerCase() !==
          identity.canonicalKey.toLowerCase()
      )
        return yield* new GitHubIssueApi.GitHubIssueApiError({
          reason: "repository-mismatch",
          host,
        });
      return yield* api.searchIssues({
        cwd,
        account,
        repository: repository.data,
        query: input.query,
      });
    }).pipe(
      Effect.mapError((cause): IssueSearchError =>
        cause.reason === "authentication" || cause.reason === "credential-missing"
          ? new PullRequestUnavailableError({ reason: "cli-unauthenticated", cause })
          : new PullRequestOperationError({
              operation: "issues.search",
              detail: "GitHub issues could not be searched.",
              cause,
            }),
      ),
    );
    // A project move or remote change must not return context from its old repository.
    const current = yield* projects.get(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "issues.search",
            detail: "The project could not be read.",
            cause,
          }),
      ),
    );
    const refreshed = yield* identities.resolve(cwd, { refresh: true });
    if (
      Option.isNone(current) ||
      current.value.deletedAt !== null ||
      current.value.workspaceRoot !== cwd ||
      refreshed?.canonicalKey !== identity.canonicalKey
    )
      return yield* new PullRequestOperationError({
        operation: "issues.search",
        detail: "The project repository changed during search.",
      });
    return yield* decodeResult({ entries }).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "issues.search",
            detail: "GitHub returned invalid issue results.",
            cause,
          }),
      ),
    );
  });
  return IssueSearchService.of({ search });
});

export const layer = Layer.effect(IssueSearchService, make);
