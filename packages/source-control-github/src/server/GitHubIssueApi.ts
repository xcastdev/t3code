import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PAGE = 10_000;
const NonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Host = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);
const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => value.split("/").every((part) => part !== "." && part !== "..")),
);
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value.replace("Z", ".000Z")
    );
  }),
);
const SourceRevision = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) &&
      DateTime.formatIso(parsed.value) ===
        (value.includes(".") ? value : value.replace("Z", ".000Z"))
    );
  }),
);
const sourceTime = (value: string) =>
  Option.getOrElse(DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis)), () => -1);
const PositiveInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Page = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_PAGE));
const PageSize = PositiveInt.check(Schema.isLessThanOrEqualTo(100));
const Etag = Schema.String.check(Schema.isPattern(/^(?:W\/)?"[\x21\x23-\x7e]{0,512}"$/u));
const isEtag = Schema.is(Etag);
const Account = Schema.Struct({
  host: Host,
  credentialFingerprint: NonEmpty,
  accountId: NonEmpty,
  viewer: NonEmpty,
});
const Repository = Schema.Struct({ host: Host, nodeId: NonEmpty, nameWithOwner: RepositoryName });
export type GitHubIssueAccount = typeof Account.Type;
export type GitHubIssueRepository = typeof Repository.Type;

const Common = {
  cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  account: Account,
};
const Paging = {
  ...Common,
  repository: Repository,
  page: Schema.optional(Page),
  pageSize: Schema.optional(PageSize),
  etag: Schema.optional(Etag),
};
const Lookup = Schema.Struct({
  ...Common,
  repository: RepositoryName,
  expectedRepositoryNodeId: Schema.optional(NonEmpty),
  etag: Schema.optional(Etag),
});
const IssuesInput = Schema.Struct({ ...Paging, since: Timestamp });
const SearchInput = Schema.Struct({
  ...Common,
  repository: Repository,
  query: Schema.String.check(Schema.isMaxLength(120)),
});
const SearchIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String.check(Schema.isMinLength(1)),
  state: Schema.Literals(["open", "closed"]),
  html_url: NonEmpty,
  repository_url: NonEmpty,
  pull_request: Schema.optional(Schema.Struct({ url: NonEmpty })),
});
const CommentsInput = Schema.Struct({
  ...Paging,
  issue: Schema.Struct({ nodeId: NonEmpty, number: PositiveInt }),
  expectedSourceRevision: Schema.optional(SourceRevision),
});
const RawRepository = Schema.Struct({
  id: PositiveInt,
  node_id: NonEmpty,
  full_name: RepositoryName,
  url: NonEmpty,
  html_url: NonEmpty,
  updated_at: Timestamp,
});
const RawIssue = Schema.Struct({
  node_id: NonEmpty,
  number: PositiveInt,
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  comments: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updated_at: Timestamp,
  closed_at: Schema.NullOr(Timestamp),
  url: NonEmpty,
  html_url: NonEmpty,
  repository_url: NonEmpty,
  pull_request: Schema.optional(Schema.Struct({ url: NonEmpty })),
});
const RawComment = Schema.Struct({
  node_id: NonEmpty,
  body: Schema.String,
  updated_at: Timestamp,
  html_url: NonEmpty,
  issue_url: NonEmpty,
});

export interface GitHubIssueRecord {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly state: "open" | "closed";
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly url: string;
  readonly commentCount: number;
}
export interface GitHubIssueComment {
  readonly nodeId: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly updatedAt: string;
  readonly url: string;
}
export type GitHubIssueRead<T> =
  | { readonly status: "not-modified"; readonly etag: string | null }
  | { readonly status: "changed"; readonly etag: string | null; readonly data: T };
export type GitHubIssuePage<T> =
  | {
      readonly status: "not-modified";
      readonly etag: string | null;
      readonly repository: GitHubIssueRepository;
    }
  | {
      readonly status: "changed";
      readonly etag: string | null;
      readonly repository: GitHubIssueRepository;
      readonly entries: ReadonlyArray<T>;
      readonly nextPage: number | null;
      readonly rawEntryCount: number;
    };

export class GitHubIssueApiError extends Schema.TaggedError<GitHubIssueApiError>()(
  "GitHubIssueApiError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "credential-missing",
      "credential-mismatch",
      "account-mismatch",
      "repository-mismatch",
      "issue-mismatch",
      "invalid-response",
      "authentication",
      "rate-limited",
      "rate-paused",
      "unavailable",
      "command-failed",
      "page-limit",
    ]),
    host: Schema.String,
    retryAt: Schema.optional(Schema.Finite),
  },
) {
  override get message() {
    return `GitHub issue read failed: ${this.reason} (${this.host}).`;
  }
}
export class GitHubIssueApi extends Context.Service<
  GitHubIssueApi,
  {
    readonly getAccount: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<GitHubIssueAccount, GitHubIssueApiError>;
    readonly lookupRepository: (
      input: typeof Lookup.Type,
    ) => Effect.Effect<
      GitHubIssueRead<GitHubIssueRepository & { readonly url: string; readonly updatedAt: string }>,
      GitHubIssueApiError
    >;
    readonly searchIssues: (input: typeof SearchInput.Type) => Effect.Effect<
      ReadonlyArray<{
        readonly number: number;
        readonly title: string;
        readonly state: "open" | "closed";
        readonly url: string;
      }>,
      GitHubIssueApiError
    >;
    readonly readIssuesPage: (
      input: typeof IssuesInput.Type,
    ) => Effect.Effect<GitHubIssuePage<GitHubIssueRecord>, GitHubIssueApiError>;
    readonly readCommentsPage: (
      input: typeof CommentsInput.Type,
    ) => Effect.Effect<GitHubIssuePage<GitHubIssueComment>, GitHubIssueApiError>;
  }
>()("@t3tools/source-control-github/server/GitHubIssueApi") {}

const isClientError = Schema.is(GitHubIssueApiError);
const failure = (reason: GitHubIssueApiError["reason"], host: string) =>
  new GitHubIssueApiError({ reason, host });
const decodeInput = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => failure("invalid-input", "unknown")),
  );
const decodeBody = <S extends Schema.Top>(schema: S, body: string, host: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError(() => failure("invalid-response", host)),
  );

function boundedText(value: string, limit: number) {
  // Avoid emitting a lone high surrogate at the truncation boundary.
  const end =
    value.length > limit && /[\uD800-\uDBFF]/u.test(value[limit - 1]!) ? limit - 1 : limit;
  return { text: value.slice(0, end), truncated: value.length > end };
}

function apiOrigin(host: string) {
  return new URL(GitHubRequestPolicy.gitHubApiUrls(host).rest).origin;
}
function apiPath(host: string, endpoint: string) {
  return `${new URL(GitHubRequestPolicy.gitHubApiUrls(host).rest).pathname.replace(/\/$/u, "")}/${endpoint}`;
}
function validApiUrl(value: string, host: string, endpoint: string) {
  return value === `${apiOrigin(host)}${apiPath(host, endpoint)}`;
}
function pageContinuation(
  link: string | undefined,
  host: string,
  repositoryId: number,
  endpoint: string,
  page: number,
  count: number,
) {
  if (link === undefined) return null;
  let next: number | null = null;
  const seen = new Set<string>();
  let last: number | null = null;
  const expected = new URL(`${apiOrigin(host)}${apiPath(host, endpoint)}`);
  // GitHub's Link header can use the REST ID instead of owner/name.
  const numericEndpoint = endpoint.replace(
    /^repos\/[^/]+\/[^/]+(?=\/)/u,
    `repositories/${repositoryId}`,
  );
  const numericPath = new URL(`${apiOrigin(host)}${apiPath(host, numericEndpoint)}`).pathname;
  for (const part of link.split(/,\s*(?=<)/u)) {
    const match = /^<([^<>\s]+)>;\s*rel="(next|prev|first|last)"$/u.exec(part.trim());
    if (!match || seen.has(match[2]!)) throw failure("invalid-response", host);
    seen.add(match[2]!);
    const url = new URL(match[1]!);
    if (
      url.origin !== expected.origin ||
      (url.pathname !== expected.pathname && url.pathname !== numericPath) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw failure("invalid-response", host);
    const rawPage = url.searchParams.get("page");
    if (rawPage === null || !/^[1-9]\d*$/u.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))
      throw failure("invalid-response", host);
    const linkedPage = Number(rawPage);
    const keys = [...url.searchParams.keys()];
    // GitHub adds cursor hints to numeric page links; validate them without forwarding them.
    const cursorKey = match[2] === "next" ? "after" : match[2] === "prev" ? "before" : undefined;
    const cursor = cursorKey === undefined ? null : url.searchParams.get(cursorKey);
    if (
      new Set(keys).size !== keys.length ||
      keys.length !== [...expected.searchParams.keys()].length + (cursor === null ? 0 : 1) ||
      (cursor !== null &&
        (cursor.length === 0 || cursor.length > 1024 || /[\s\p{Cc}]/u.test(cursor)))
    )
      throw failure("invalid-response", host);
    for (const [key, value] of expected.searchParams)
      if (key !== "page" && url.searchParams.get(key) !== value)
        throw failure("invalid-response", host);
    if (match[2] === "next") {
      if (linkedPage !== page + 1 || count === 0) throw failure("invalid-response", host);
      if (linkedPage > MAX_PAGE) throw failure("page-limit", host);
      next = linkedPage;
    } else if (match[2] === "prev" && linkedPage !== page - 1)
      throw failure("invalid-response", host);
    else if (match[2] === "first" && linkedPage !== 1) throw failure("invalid-response", host);
    else if (match[2] === "last") {
      if (linkedPage < page) throw failure("invalid-response", host);
      last = linkedPage;
    }
  }
  if (last !== null && ((last > page && next === null) || (next !== null && last < next)))
    throw failure("invalid-response", host);
  return next;
}

/** Server-local reads only. Callers own cursor persistence, overlap windows and dispatch policy. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const identities = yield* GitHubPullRequestApi.GitHubPullRequestApi;

  const mapTransportError = (error: GitHubPullRequestApi.GitHubPullRequestApiError) => {
    const host = "host" in error ? error.host : "unknown";
    switch (error._tag) {
      case "GitHubApiRateLimitError":
      case "SourceControlRateLimitPausedError":
        return new GitHubIssueApiError({
          reason: error._tag === "GitHubApiRateLimitError" ? "rate-limited" : "rate-paused",
          host,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        });
      case "GitHubApiAuthenticationError":
      case "GitHubNotSignedInError":
      case "GitHubHostDisabledError":
        return failure("authentication", host);
      default:
        return failure("unavailable", host);
    }
  };
  const getAccount: GitHubIssueApi["Service"]["getAccount"] = Effect.fn(
    "GitHubIssueApi.getAccount",
  )(function* (input) {
    const host = yield* decodeInput(Host, input.host);
    return yield* identities
      .withVerifiedCredential({ ...input, host }, (identity) =>
        Effect.succeed({ host, ...identity }),
      )
      .pipe(
        Effect.mapError(mapTransportError),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      );
  });
  const withAccount = <A>(
    input: { readonly cwd: string; readonly account: GitHubIssueAccount },
    use: () => Effect.Effect<A, GitHubIssueApiError>,
  ) =>
    identities
      .withVerifiedCredential({ cwd: input.cwd, host: input.account.host }, (identity) => {
        if (identity.credentialFingerprint !== input.account.credentialFingerprint)
          return Effect.fail(failure("credential-mismatch", input.account.host));
        if (
          identity.accountId !== input.account.accountId ||
          identity.viewer !== input.account.viewer
        )
          return Effect.fail(failure("account-mismatch", input.account.host));
        return use();
      })
      .pipe(
        Effect.mapError((error) => (isClientError(error) ? error : mapTransportError(error))),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      );

  const request = Effect.fn("GitHubIssueApi.request")(function* (
    _cwd: string,
    account: GitHubIssueAccount,
    endpoint: string,
    etag?: string,
    quotaResource: "core" | "search" = "core",
  ) {
    const response = yield* api
      .rest({
        host: account.host,
        operation: "issueRead",
        path: endpoint,
        ...(etag === undefined ? {} : { ifNoneMatch: etag }),
        maxResponseBytes: MAX_OUTPUT_BYTES,
        allowReserve: false,
        quotaResource,
      })
      .pipe(Effect.mapError(mapTransportError));
    const responseEtag = response.headers.etag ?? null;
    if (
      response.truncated ||
      response.invalidUtf8 ||
      Buffer.byteLength(response.body) > MAX_OUTPUT_BYTES ||
      (responseEtag !== null && !isEtag(responseEtag))
    )
      return yield* failure("invalid-response", account.host);
    if (response.status === 304) {
      if (etag === undefined || response.body.trim() !== "" || response.headers.link !== undefined)
        return yield* failure("invalid-response", account.host);
    } else if (
      response.status !== 200 ||
      !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(
        response.headers["content-type"] ?? "",
      )
    )
      return yield* failure("invalid-response", account.host);
    return { ...response, etag: responseEtag, headers: new Map(Object.entries(response.headers)) };
  });
  const repositoryRead = Effect.fn("GitHubIssueApi.repositoryRead")(function* (
    cwd: string,
    account: GitHubIssueAccount,
    name: string,
    expected?: string,
    etag?: string,
  ) {
    const response = yield* request(cwd, account, `repos/${name}`, etag);
    if (response.status === 304)
      return { status: "not-modified" as const, etag: response.etag } as const;
    const raw = yield* decodeBody(RawRepository, response.body, account.host);
    if (expected !== undefined && raw.node_id !== expected)
      return yield* failure("repository-mismatch", account.host);
    if (
      !validApiUrl(raw.url, account.host, `repos/${raw.full_name}`) ||
      raw.html_url !== `https://${account.host}/${raw.full_name}`
    )
      return yield* failure("invalid-response", account.host);
    return {
      status: "changed" as const,
      etag: response.etag,
      restId: raw.id,
      data: {
        host: account.host,
        nodeId: raw.node_id,
        nameWithOwner: raw.full_name,
        url: raw.html_url,
        updatedAt: raw.updated_at,
      },
    } as const;
  });
  const verifyRepository = Effect.fn("GitHubIssueApi.verifyRepository")(function* (
    cwd: string,
    account: GitHubIssueAccount,
    expected: GitHubIssueRepository,
  ) {
    if (account.host !== expected.host) return yield* failure("repository-mismatch", account.host);
    const read = yield* repositoryRead(cwd, account, expected.nameWithOwner, expected.nodeId);
    if (read.status !== "changed") return yield* failure("invalid-response", account.host);
    return {
      restId: read.restId,
      repository: {
        host: read.data.host,
        nodeId: read.data.nodeId,
        nameWithOwner: read.data.nameWithOwner,
      },
    };
  });
  const lookupRepository: GitHubIssueApi["Service"]["lookupRepository"] = Effect.fn(
    "GitHubIssueApi.lookupRepository",
  )(function* (input) {
    const valid = yield* decodeInput(Lookup, input);
    if (valid.etag !== undefined && valid.expectedRepositoryNodeId === undefined)
      return yield* failure("invalid-input", valid.account.host);
    return yield* withAccount(valid, () =>
      Effect.gen(function* () {
        // Pin identity unconditionally before a conditional lookup can return 304.
        if (valid.etag !== undefined)
          yield* repositoryRead(
            valid.cwd,
            valid.account,
            valid.repository,
            valid.expectedRepositoryNodeId,
          );
        const read = yield* repositoryRead(
          valid.cwd,
          valid.account,
          valid.repository,
          valid.expectedRepositoryNodeId,
          valid.etag,
        );
        if (read.status === "not-modified") return read;
        return { status: read.status, etag: read.etag, data: read.data };
      }),
    );
  });
  const searchIssues: GitHubIssueApi["Service"]["searchIssues"] = Effect.fn(
    "GitHubIssueApi.searchIssues",
  )(function* (input) {
    const valid = yield* decodeInput(SearchInput, input);
    return yield* withAccount(valid, () =>
      Effect.gen(function* () {
        const { repository } = yield* verifyRepository(valid.cwd, valid.account, valid.repository);
        // Quote each term so user text cannot inject repo/org/type qualifiers into this scoped read.
        const terms = valid.query
          .trim()
          .split(/\s+/u)
          .filter(Boolean)
          .map((term) => `"${term.replace(/["\\]/gu, " ")}"`)
          .join(" ");
        const query = `repo:${repository.nameWithOwner} is:issue${terms ? ` ${terms} in:title` : ""}`;
        const response = yield* request(
          valid.cwd,
          valid.account,
          `search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100`,
          undefined,
          "search",
        );
        const body = yield* decodeBody(
          Schema.Struct({
            incomplete_results: Schema.Boolean,
            items: Schema.Array(SearchIssue).check(Schema.isMaxLength(100)),
          }),
          response.body,
          repository.host,
        );
        const entries = [];
        for (const row of body.items) {
          if (
            row.pull_request !== undefined ||
            !validApiUrl(
              row.repository_url,
              repository.host,
              `repos/${repository.nameWithOwner}`,
            ) ||
            row.html_url !==
              `https://${repository.host}/${repository.nameWithOwner}/issues/${row.number}`
          )
            return yield* failure("invalid-response", repository.host);
          entries.push({
            number: row.number,
            title: boundedText(row.title, 2048).text,
            state: row.state,
            url: row.html_url,
          });
        }
        yield* verifyRepository(valid.cwd, valid.account, repository);
        return entries;
      }),
    );
  });
  const readIssuesPage: GitHubIssueApi["Service"]["readIssuesPage"] = Effect.fn(
    "GitHubIssueApi.readIssuesPage",
  )(function* (input) {
    const valid = yield* decodeInput(IssuesInput, input);
    return yield* withAccount(valid, () =>
      Effect.gen(function* () {
        const verified = yield* verifyRepository(valid.cwd, valid.account, valid.repository);
        const { repository } = verified;
        const page = valid.page ?? 1,
          pageSize = valid.pageSize ?? 100;
        // The stored epoch sentinel means a full sweep; GitHub returns no issues for that filter.
        const since =
          valid.since === "1970-01-01T00:00:00Z" ? "" : `&since=${encodeURIComponent(valid.since)}`;
        const endpoint = `repos/${repository.nameWithOwner}/issues?state=all&sort=updated&direction=asc${since}&per_page=${pageSize}&page=${page}`;
        const response = yield* request(valid.cwd, valid.account, endpoint, valid.etag);
        if (response.status === 304)
          return { status: "not-modified" as const, etag: response.etag, repository };
        const rows = yield* decodeBody(
          Schema.Array(RawIssue).check(Schema.isMaxLength(pageSize)),
          response.body,
          valid.account.host,
        );
        const entries: GitHubIssueRecord[] = [];
        for (const raw of rows) {
          if (
            !validApiUrl(
              raw.repository_url,
              repository.host,
              `repos/${repository.nameWithOwner}`,
            ) ||
            !validApiUrl(
              raw.url,
              repository.host,
              `repos/${repository.nameWithOwner}/issues/${raw.number}`,
            )
          )
            return yield* failure("invalid-response", repository.host);
          if (raw.pull_request !== undefined) continue;
          if (
            raw.html_url !==
            `https://${repository.host}/${repository.nameWithOwner}/issues/${raw.number}`
          )
            return yield* failure("invalid-response", repository.host);
          const title = boundedText(raw.title, 4000),
            body = boundedText(raw.body ?? "", 32_000);
          entries.push({
            nodeId: raw.node_id,
            number: raw.number,
            title: title.text,
            titleTruncated: title.truncated,
            body: body.text,
            bodyTruncated: body.truncated,
            state: raw.state,
            updatedAt: raw.updated_at,
            closedAt: raw.closed_at,
            url: raw.html_url,
            commentCount: raw.comments,
          });
        }
        const nextPage = yield* Effect.try({
          try: () =>
            pageContinuation(
              response.headers.get("link"),
              repository.host,
              verified.restId,
              endpoint,
              page,
              rows.length,
            ),
          catch: (e) => (isClientError(e) ? e : failure("invalid-response", repository.host)),
        });
        // Detect a repository name rebound during the read before accepting any page data.
        yield* verifyRepository(valid.cwd, valid.account, repository);
        return {
          status: "changed" as const,
          etag: response.etag,
          repository,
          entries,
          nextPage,
          rawEntryCount: rows.length,
        };
      }),
    );
  });
  const readCommentsPage: GitHubIssueApi["Service"]["readCommentsPage"] = Effect.fn(
    "GitHubIssueApi.readCommentsPage",
  )(function* (input) {
    const valid = yield* decodeInput(CommentsInput, input);
    return yield* withAccount(valid, () =>
      Effect.gen(function* () {
        const verified = yield* verifyRepository(valid.cwd, valid.account, valid.repository);
        const { repository } = verified;
        const issueEndpoint = `repos/${repository.nameWithOwner}/issues/${valid.issue.number}`;
        const verifyIssue = Effect.fn("GitHubIssueApi.verifyCommentSource")(function* () {
          const issueResponse = yield* request(valid.cwd, valid.account, issueEndpoint);
          const issue = yield* decodeBody(RawIssue, issueResponse.body, repository.host);
          if (
            issue.node_id !== valid.issue.nodeId ||
            issue.number !== valid.issue.number ||
            issue.pull_request !== undefined ||
            (valid.expectedSourceRevision !== undefined &&
              sourceTime(issue.updated_at) !== sourceTime(valid.expectedSourceRevision))
          )
            return yield* failure("issue-mismatch", repository.host);
          if (
            !validApiUrl(issue.url, repository.host, issueEndpoint) ||
            !validApiUrl(issue.repository_url, repository.host, `repos/${repository.nameWithOwner}`)
          )
            return yield* failure("invalid-response", repository.host);
          return issue;
        });
        const issue = yield* verifyIssue();
        const page = valid.page ?? 1,
          pageSize = valid.pageSize ?? 100;
        const endpoint = `${issueEndpoint}/comments?per_page=${pageSize}&page=${page}`;
        const response = yield* request(valid.cwd, valid.account, endpoint, valid.etag);
        if (valid.expectedSourceRevision !== undefined) {
          yield* verifyRepository(valid.cwd, valid.account, repository);
          yield* verifyIssue();
        }
        if (response.status === 304)
          return { status: "not-modified" as const, etag: response.etag, repository };
        const rows = yield* decodeBody(
          Schema.Array(RawComment).check(Schema.isMaxLength(pageSize)),
          response.body,
          repository.host,
        );
        const entries: GitHubIssueComment[] = [];
        for (const raw of rows) {
          if (
            raw.issue_url !== issue.url ||
            !raw.html_url.startsWith(
              `https://${repository.host}/${repository.nameWithOwner}/issues/${issue.number}#issuecomment-`,
            )
          )
            return yield* failure("invalid-response", repository.host);
          const body = boundedText(raw.body, 32_000);
          entries.push({
            nodeId: raw.node_id,
            body: body.text,
            bodyTruncated: body.truncated,
            updatedAt: raw.updated_at,
            url: raw.html_url,
          });
        }
        const nextPage = yield* Effect.try({
          try: () =>
            pageContinuation(
              response.headers.get("link"),
              repository.host,
              verified.restId,
              endpoint,
              page,
              rows.length,
            ),
          catch: (e) => (isClientError(e) ? e : failure("invalid-response", repository.host)),
        });
        if (valid.expectedSourceRevision === undefined)
          yield* verifyRepository(valid.cwd, valid.account, repository);
        return {
          status: "changed" as const,
          etag: response.etag,
          repository,
          entries,
          nextPage,
          rawEntryCount: rows.length,
        };
      }),
    );
  });
  return GitHubIssueApi.of({
    getAccount,
    lookupRepository,
    searchIssues,
    readIssuesPage,
    readCommentsPage,
  });
});
export const layer = Layer.effect(GitHubIssueApi, make);
