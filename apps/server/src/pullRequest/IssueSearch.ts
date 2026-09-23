import {
  detectSourceControlProviderFromRemoteUrl,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type IssueSearchEntry,
  type IssueSearchInput,
  type IssueSearchResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";

const LIMIT = 30;

export function issueSearchArgs(
  provider: "github" | "gitlab",
  host: string,
  repository: string,
  query: string,
): string[] {
  const issueNumber = /^[1-9]\d*$/u.test(query) ? Number(query) : null;
  if (provider === "github") {
    if (issueNumber !== null)
      return ["api", "--hostname", host, `repos/${repository}/issues/${issueNumber}`];
    if (query)
      return [
        "api",
        "--hostname",
        host,
        "--method",
        "GET",
        "search/issues",
        "-f",
        `q=repo:${repository} is:issue ${query}`,
        "-f",
        `per_page=${LIMIT}`,
      ];
    return ["api", "--hostname", host, `repos/${repository}/issues?state=all&per_page=${LIMIT}`];
  }
  const endpoint = `projects/${encodeURIComponent(repository)}/issues`;
  return [
    "api",
    "--hostname",
    host,
    issueNumber !== null
      ? `${endpoint}/${issueNumber}`
      : `${endpoint}?scope=all&state=all&per_page=${LIMIT}${query ? `&search=${encodeURIComponent(query)}` : ""}`,
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function decodeIssueSearchResult(
  raw: string,
  provider: "github" | "gitlab",
): IssueSearchResult {
  const value: unknown = JSON.parse(raw);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(record(value)?.items)
      ? (record(value)!.items as unknown[])
      : value !== null && typeof value === "object"
        ? [value]
        : [];
  const entries: IssueSearchEntry[] = [];
  for (const row of rows) {
    const item = record(row);
    if (!item || (provider === "github" && item.pull_request !== undefined)) continue;
    const number = provider === "gitlab" ? item.iid : item.number;
    const url = provider === "gitlab" ? item.web_url : item.html_url;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof url !== "string" ||
      !/^https?:\/\//u.test(url) ||
      (item.state !== "open" && item.state !== "opened" && item.state !== "closed")
    )
      continue;
    entries.push({
      number,
      title: item.title.trim(),
      url,
      state: item.state === "opened" ? "open" : item.state,
    });
    if (entries.length >= LIMIT) break;
  }
  return { entries };
}

export const searchIssues = Effect.fn("IssueSearch.search")(function* (input: IssueSearchInput) {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const project = yield* projections.getProjectShellById(input.projectId).pipe(
    Effect.mapError(
      (cause) =>
        new PullRequestOperationError({
          operation: "searchIssues",
          detail: "The project could not be read.",
          cause,
        }),
    ),
  );
  if (Option.isNone(project)) {
    return yield* new PullRequestOperationError({
      operation: "searchIssues",
      detail: "The project was not found.",
      cause: input.projectId,
    });
  }
  const identity = project.value.repositoryIdentity;
  const provider = identity && detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
  const repository = sourceControlRepositorySelector(identity);
  if (!provider || !repository || (provider.kind !== "github" && provider.kind !== "gitlab")) {
    return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
  }
  const providerKind = provider.kind;
  const host = new URL(provider.baseUrl).host;
  const query = input.query.trim();
  const issueNumber = /^[1-9]\d*$/u.test(query) ? Number(query) : null;
  const cwd = project.value.workspaceRoot;
  const github = yield* GitHubCli.GitHubCli;
  const gitlab = yield* GitLabCli.GitLabCli;
  const outputEffect =
    providerKind === "github"
      ? github
          .execute({
            cwd,
            args: issueSearchArgs(providerKind, host, repository, query),
            env: { GH_PROMPT_DISABLED: "1" },
            maxOutputBytes: 512_000,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PullRequestOperationError({
                  operation: "searchIssues",
                  detail: cause.detail,
                  cause,
                }),
            ),
          )
      : gitlab
          .execute({
            cwd,
            args: issueSearchArgs(providerKind, host, repository, query),
            maxOutputBytes: 512_000,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PullRequestOperationError({
                  operation: "searchIssues",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
  const output = yield* outputEffect.pipe(
    Effect.catch((error) =>
      issueNumber !== null && /404|not found/iu.test(error.detail)
        ? Effect.succeed(null)
        : Effect.fail(error),
    ),
  );
  if (output === null) return { entries: [] };
  return yield* Effect.try({
    try: () => decodeIssueSearchResult(output.stdout, providerKind),
    catch: (cause) =>
      new PullRequestOperationError({
        operation: "searchIssues",
        detail: "The issue list could not be decoded.",
        cause,
      }),
  });
});
