import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as RateLimit from "../../sourceControl/SourceControlRateLimit.ts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PAGE = 10_000;
const NonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Host = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);
const RepositoryName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u));
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
const Account = Schema.Struct({ host: Host, credentialFingerprint: NonEmpty, nodeId: NonEmpty });
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

export class GitHubIssueClientError extends Schema.TaggedError<GitHubIssueClientError>()(
  "GitHubIssueClientError",
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
export class GitHubIssueClient extends Context.Service<
  GitHubIssueClient,
  {
    readonly lookupRepository: (
      input: typeof Lookup.Type,
    ) => Effect.Effect<
      GitHubIssueRead<GitHubIssueRepository & { readonly url: string; readonly updatedAt: string }>,
      GitHubIssueClientError
    >;
    readonly readIssuesPage: (
      input: typeof IssuesInput.Type,
    ) => Effect.Effect<GitHubIssuePage<GitHubIssueRecord>, GitHubIssueClientError>;
    readonly readCommentsPage: (
      input: typeof CommentsInput.Type,
    ) => Effect.Effect<GitHubIssuePage<GitHubIssueComment>, GitHubIssueClientError>;
  }
>()("t3/projectWork/github/GitHubIssueClient") {}

const isClientError = Schema.is(GitHubIssueClientError);
const failure = (reason: GitHubIssueClientError["reason"], host: string) =>
  new GitHubIssueClientError({ reason, host });
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

// gh's status line uses LF; its headers use CRLF. Only one response is accepted.
function parseEnvelope(stdout: string, host: string) {
  const separator = /\r?\n\r?\n/u.exec(stdout);
  if (!separator || separator.index > 32_768) throw failure("invalid-response", host);
  const lines = stdout.slice(0, separator.index).split(/\r?\n/u);
  const status = /^HTTP\/(?:1\.0|1\.1|2\.0|2|3\.0|3) ([1-5]\d{2})(?: [\x20-\x7e]*)?$/u.exec(
    lines.shift() ?? "",
  );
  if (!status) throw failure("invalid-response", host);
  const headers = new Map<string, string>();
  let count = 0;
  while (lines.length > 0) {
    const line = lines.shift()!;
    // HTTP field values allow tabs but reject other control characters.
    // eslint-disable-next-line no-control-regex
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/u.exec(line);
    if (!match || ++count > 100 || line.length > 8192) throw failure("invalid-response", host);
    const key = match[1]!.toLowerCase();
    if (headers.has(key)) throw failure("invalid-response", host);
    headers.set(key, match[2]!.trim());
  }
  const etag = headers.get("etag") ?? null;
  if (etag !== null && !isEtag(etag)) throw failure("invalid-response", host);
  return {
    status: Number(status[1]),
    headers,
    etag,
    body: stdout.slice(separator.index + separator[0].length),
  };
}

function apiOrigin(host: string) {
  return host === "github.com" ? "https://api.github.com" : `https://${host}`;
}
function apiPath(host: string, endpoint: string) {
  return `${host === "github.com" ? "" : "/api/v3"}/${endpoint}`;
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
    if (
      new Set(keys).size !== keys.length ||
      keys.length !== [...expected.searchParams.keys()].length
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
  const gh = yield* GitHubCli.GitHubCli;
  const rates = yield* RateLimit.SourceControlRateLimit;

  const recordPause = Effect.fn("GitHubIssueClient.recordPause")(function* (
    host: string,
    lease: number,
    retryAt?: number,
  ) {
    const key = { provider: "github", host } as const;
    if (retryAt !== undefined) yield* rates.recordRateLimit({ ...key, lease, retryAt });
    else {
      const now = yield* Clock.currentTimeMillis;
      yield* rates.recordRateLimit({ ...key, lease });
      // Keep the default backoff attempt; the same stale lease only extends its minimum.
      yield* rates.recordRateLimit({ ...key, lease, retryAt: now + 60_000 });
    }
    return yield* rates
      .check(key)
      .pipe(Effect.match({ onFailure: (error) => error.retryAt, onSuccess: () => undefined }));
  });

  const request = Effect.fn("GitHubIssueClient.request")(function* (
    cwd: string,
    account: GitHubIssueAccount,
    endpoint: string,
    etag?: string,
  ) {
    const credential = yield* GitHubCli.PinnedGitHubCredential;
    if (credential === null) return yield* failure("credential-missing", account.host);
    if (
      credential.host !== account.host ||
      credential.credentialFingerprint !== account.credentialFingerprint
    )
      return yield* failure("credential-mismatch", account.host);
    const key = { provider: "github", host: account.host } as const;
    const lease = yield* rates.check(key).pipe(
      Effect.mapError(
        (e) =>
          new GitHubIssueClientError({
            reason: "rate-paused",
            host: account.host,
            retryAt: e.retryAt,
          }),
      ),
    );
    const result = yield* gh
      .execute({
        cwd,
        args: [
          "api",
          "--hostname",
          account.host,
          "--method",
          "GET",
          "--include",
          "-H",
          "Accept: application/vnd.github+json",
          ...(etag === undefined ? [] : ["-H", `If-None-Match: ${etag}`]),
          endpoint,
        ],
        env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0" },
        maxOutputBytes: MAX_OUTPUT_BYTES,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.catch(
          Effect.fn(function* (error) {
            if (error._tag === "GitHubCliRateLimitError") {
              const retryAt = yield* recordPause(account.host, lease);
              return yield* new GitHubIssueClientError({
                reason: "rate-limited",
                host: account.host,
                retryAt,
              });
            }
            return yield* failure(
              error._tag === "GitHubCliAuthenticationError"
                ? "authentication"
                : error._tag === "GitHubCliUnavailableError"
                  ? "unavailable"
                  : "command-failed",
              account.host,
            );
          }),
        ),
      );
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8 ||
      result.stderrInvalidUtf8 ||
      Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES
    )
      return yield* failure("invalid-response", account.host);
    const envelope = yield* Effect.try({
      try: () => parseEnvelope(result.stdout, account.host),
      catch: () => failure("invalid-response", account.host),
    });
    const now = yield* Clock.currentTimeMillis;
    const exhausted = envelope.headers.get("x-ratelimit-remaining") === "0";
    const reset = envelope.headers.get("x-ratelimit-reset");
    const retryHeader = RateLimit.retryAtFromHeader(envelope.headers.get("retry-after"), now);
    const resetAt =
      exhausted &&
      reset !== undefined &&
      /^\d+$/u.test(reset) &&
      Number.isSafeInteger(Number(reset) * 1000)
        ? Number(reset) * 1000
        : undefined;
    const retryAt =
      retryHeader !== undefined && retryHeader > now
        ? retryHeader
        : resetAt !== undefined && resetAt > now
          ? resetAt
          : undefined;
    const decisive =
      envelope.status === 429 ||
      (envelope.status === 403 && (exhausted || envelope.headers.has("retry-after")));
    // Quota headers remain authoritative even when an optional error message is malformed.
    const recordedRetryAt =
      decisive || exhausted ? yield* recordPause(account.host, lease, retryAt) : undefined;
    if (decisive)
      return yield* new GitHubIssueClientError({
        reason: "rate-limited",
        host: account.host,
        retryAt: recordedRetryAt,
      });
    if (envelope.status === 403) {
      const errorMessage = yield* decodeBody(
        Schema.Struct({ message: Schema.String }),
        envelope.body,
        account.host,
      );
      if (/secondary rate limit|rate limit exceeded|api rate limit/iu.test(errorMessage.message)) {
        const recordedRetryAt = yield* recordPause(account.host, lease, retryAt);
        return yield* new GitHubIssueClientError({
          reason: "rate-limited",
          host: account.host,
          retryAt: recordedRetryAt,
        });
      }
    }
    if (envelope.status === 401 || envelope.status === 403)
      return yield* failure("authentication", account.host);
    if (envelope.status === 304) {
      if (
        (result.exitCode !== 0 && result.exitCode !== 1) ||
        etag === undefined ||
        envelope.body.trim() !== "" ||
        envelope.headers.has("link")
      )
        return yield* failure("invalid-response", account.host);
    } else if (
      envelope.status !== 200 ||
      result.exitCode !== 0 ||
      !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(
        envelope.headers.get("content-type") ?? "",
      )
    )
      return yield* failure("invalid-response", account.host);
    yield* rates.recordSuccess({ ...key, lease });
    return envelope;
  });

  const verifyAccount = Effect.fn("GitHubIssueClient.verifyAccount")(function* (
    cwd: string,
    account: GitHubIssueAccount,
  ) {
    const response = yield* request(cwd, account, "user");
    const user = yield* decodeBody(
      Schema.Struct({ node_id: NonEmpty }),
      response.body,
      account.host,
    );
    if (user.node_id !== account.nodeId) return yield* failure("account-mismatch", account.host);
  });
  const repositoryRead = Effect.fn("GitHubIssueClient.repositoryRead")(function* (
    cwd: string,
    account: GitHubIssueAccount,
    name: string,
    expected?: string,
    etag?: string,
  ) {
    const response = yield* request(cwd, account, `repos/${name}`, etag);
    if (response.status === 304) return { status: "not-modified", etag: response.etag } as const;
    const raw = yield* decodeBody(RawRepository, response.body, account.host);
    if (expected !== undefined && raw.node_id !== expected)
      return yield* failure("repository-mismatch", account.host);
    if (
      !validApiUrl(raw.url, account.host, `repos/${raw.full_name}`) ||
      raw.html_url !== `https://${account.host}/${raw.full_name}`
    )
      return yield* failure("invalid-response", account.host);
    return {
      status: "changed",
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
  const verifyRepository = Effect.fn("GitHubIssueClient.verifyRepository")(function* (
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
  const lookupRepository: GitHubIssueClient["Service"]["lookupRepository"] = Effect.fn(
    "GitHubIssueClient.lookupRepository",
  )(function* (input) {
    const valid = yield* decodeInput(Lookup, input);
    if (valid.etag !== undefined && valid.expectedRepositoryNodeId === undefined)
      return yield* failure("invalid-input", valid.account.host);
    yield* verifyAccount(valid.cwd, valid.account);
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
  });
  const readIssuesPage: GitHubIssueClient["Service"]["readIssuesPage"] = Effect.fn(
    "GitHubIssueClient.readIssuesPage",
  )(function* (input) {
    const valid = yield* decodeInput(IssuesInput, input);
    yield* verifyAccount(valid.cwd, valid.account);
    const verified = yield* verifyRepository(valid.cwd, valid.account, valid.repository);
    const { repository } = verified;
    const page = valid.page ?? 1,
      pageSize = valid.pageSize ?? 100;
    const endpoint = `repos/${repository.nameWithOwner}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(valid.since)}&per_page=${pageSize}&page=${page}`;
    const response = yield* request(valid.cwd, valid.account, endpoint, valid.etag);
    if (response.status === 304) return { status: "not-modified", etag: response.etag, repository };
    const rows = yield* decodeBody(
      Schema.Array(RawIssue).check(Schema.isMaxLength(pageSize)),
      response.body,
      valid.account.host,
    );
    const entries: GitHubIssueRecord[] = [];
    for (const raw of rows) {
      if (
        !validApiUrl(raw.repository_url, repository.host, `repos/${repository.nameWithOwner}`) ||
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
      status: "changed",
      etag: response.etag,
      repository,
      entries,
      nextPage,
      rawEntryCount: rows.length,
    };
  });
  const readCommentsPage: GitHubIssueClient["Service"]["readCommentsPage"] = Effect.fn(
    "GitHubIssueClient.readCommentsPage",
  )(function* (input) {
    const valid = yield* decodeInput(CommentsInput, input);
    yield* verifyAccount(valid.cwd, valid.account);
    const verified = yield* verifyRepository(valid.cwd, valid.account, valid.repository);
    const { repository } = verified;
    const issueEndpoint = `repos/${repository.nameWithOwner}/issues/${valid.issue.number}`;
    const verifyIssue = Effect.fn("GitHubIssueClient.verifyCommentSource")(function* () {
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
    if (response.status === 304) return { status: "not-modified", etag: response.etag, repository };
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
      status: "changed",
      etag: response.etag,
      repository,
      entries,
      nextPage,
      rawEntryCount: rows.length,
    };
  });
  return GitHubIssueClient.of({ lookupRepository, readIssuesPage, readCommentsPage });
});
export const layer = Layer.effect(GitHubIssueClient, make);
