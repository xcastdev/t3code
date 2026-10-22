import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/http";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubIssueApi from "./GitHubIssueApi.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const stamp = "2026-10-01T00:00:00Z";
const repository = { host: "github.com", nodeId: "repo-1", nameWithOwner: "acme/web" };
const account = {
  host: "github.com",
  accountId: "123",
  viewer: "viewer",
  credentialFingerprint: "github.com:fingerprint",
};
const input = { cwd: "/w", account, repository, since: "1970-01-01T00:00:00Z", pageSize: 1 };
const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
const repoJson = (host = "github.com") => ({
  id: 1,
  node_id: "repo-1",
  full_name: "acme/web",
  url: `${GitHubRequestPolicy.gitHubApiUrls(host).rest}/repos/acme/web`,
  html_url: `https://${host}/acme/web`,
  updated_at: stamp,
});
const issueJson = (extra: Readonly<Record<string, unknown>> = {}) => ({
  node_id: "issue-1",
  number: 1,
  title: "Issue",
  body: "Body",
  state: "open",
  comments: 1,
  updated_at: stamp,
  closed_at: null,
  url: "https://api.github.com/repos/acme/web/issues/1",
  html_url: "https://github.com/acme/web/issues/1",
  repository_url: "https://api.github.com/repos/acme/web",
  ...extra,
});
function harness(
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  signedIn = true,
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const transport = GitHubRest.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const fetchOptions = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
            expect(fetchOptions).toMatchObject({ _tag: "Some", value: { redirect: "error" } });
            requests.push(request);
            const url = new URL(request.url);
            return HttpClientResponse.fromWeb(
              request,
              url.pathname.endsWith("/user")
                ? json({ id: 123, login: "viewer" })
                : respond(request),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(GitHubCredentials.GitHubCredentials, {
        get: (host) =>
          signedIn
            ? Effect.succeed({
                host,
                token: Redacted.make("secret"),
                source: "gh" as const,
                fingerprint: `${host}:fingerprint`,
              })
            : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  const layer = GitHubIssueApi.layer.pipe(
    Layer.provideMerge(GitHubPullRequestApi.layer),
    Layer.provide(transport),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(NodeServices.layer),
  );
  return { layer, requests };
}

describe("GitHubIssueApi", () => {
  it.effect("searches only the pinned repository and returns bounded summaries", () => {
    const { layer, requests } = harness((request) =>
      new URL(request.url).pathname.endsWith("/search/issues")
        ? json({ incomplete_results: false, items: [issueJson({ title: "x".repeat(3000) })] })
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      const entries = yield* api.searchIssues({
        cwd: "/w",
        account,
        repository,
        query: 'repo:other/private is:pr "quoted"',
      });
      expect(entries).toEqual([
        {
          number: 1,
          title: "x".repeat(2048),
          state: "open",
          url: "https://github.com/acme/web/issues/1",
        },
      ]);
      const search = requests.find((request) =>
        new URL(request.url).pathname.endsWith("/search/issues"),
      )!;
      const query = new URL(search.url).searchParams.get("q");
      expect(query).toBe('repo:acme/web is:issue "repo:other/private" "is:pr" " quoted " in:title');
      expect(
        requests.filter((request) => new URL(request.url).pathname.endsWith("/repos/acme/web")),
      ).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain("secret");
    }).pipe(Effect.provide(layer));
  });
  it.effect("stops exhausted search quota before HTTP while leaving core reads available", () => {
    const { layer, requests } = harness((request) =>
      new URL(request.url).pathname.endsWith("/search/issues")
        ? json(
            { incomplete_results: false, items: [] },
            {
              headers: {
                "x-ratelimit-resource": "search",
                "x-ratelimit-limit": "30",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "2147483647",
              },
            },
          )
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      const search = { cwd: "/w", account, repository, query: "" };
      expect(yield* api.searchIssues(search)).toEqual([]);
      const second = yield* Effect.result(api.searchIssues(search));
      expect(second).toMatchObject({ _tag: "Failure", failure: { reason: "rate-paused" } });
      expect(
        requests.filter((request) => new URL(request.url).pathname.endsWith("/search/issues")),
      ).toHaveLength(1);
      expect(
        yield* api.lookupRepository({ cwd: "/w", account, repository: repository.nameWithOwner }),
      ).toMatchObject({ status: "changed" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects oversized queries and changed account before search access", () => {
    const { layer, requests } = harness(() => json(repoJson()));
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect(
        (yield* Effect.flip(
          api.searchIssues({ cwd: "/w", account, repository, query: "x".repeat(121) }),
        )).reason,
      ).toBe("invalid-input");
      expect(
        (yield* Effect.flip(
          api.searchIssues({
            cwd: "/w",
            account: { ...account, accountId: "other" },
            repository,
            query: "",
          }),
        )).reason,
      ).toBe("account-mismatch");
      expect(requests.every((request) => new URL(request.url).pathname.endsWith("/user"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects search hits outside the pinned repository", () => {
    const { layer } = harness((request) =>
      new URL(request.url).pathname.endsWith("/search/issues")
        ? json({
            incomplete_results: false,
            items: [issueJson({ repository_url: "https://api.github.com/repos/other/private" })],
          })
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect(
        (yield* Effect.flip(api.searchIssues({ cwd: "/w", account, repository, query: "" })))
          .reason,
      ).toBe("invalid-response");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the raw page continuation when every row is a pull request", () => {
    const { layer, requests } = harness((request) =>
      new URL(request.url).pathname.endsWith("/issues")
        ? json(
            [issueJson({ pull_request: { url: "https://api.github.com/repos/acme/web/pulls/1" } })],
            {
              headers: {
                etag: '"page"',
                link: '<https://api.github.com/repositories/1/issues?state=all&sort=updated&direction=asc&per_page=1&page=2>; rel="next"',
              },
            },
          )
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect(yield* api.getAccount({ cwd: "/w", host: "github.com" })).toEqual(account);
      const page = yield* api.readIssuesPage(input);
      expect(page).toMatchObject({
        status: "changed",
        entries: [],
        rawEntryCount: 1,
        nextPage: 2,
        etag: '"page"',
      });
      expect(requests.every((request) => request.headers.authorization === "Bearer secret")).toBe(
        true,
      );
      expect(JSON.stringify(page)).not.toContain("secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns conditional 304 only after verifying repository identity", () => {
    const { layer, requests } = harness((request) =>
      new URL(request.url).pathname.endsWith("/issues")
        ? new Response(null, { status: 304 })
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect(yield* api.readIssuesPage({ ...input, etag: '"cached"' })).toEqual({
        status: "not-modified",
        etag: null,
        repository,
      });
      expect(
        requests.find((request) => new URL(request.url).pathname.endsWith("/issues"))?.headers[
          "if-none-match"
        ],
      ).toBe('"cached"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects wrong account and rotated credential before repository access", () => {
    const { layer, requests } = harness(() => json(repoJson()));
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect(
        (yield* Effect.flip(
          api.readIssuesPage({ ...input, account: { ...account, accountId: "other" } }),
        )).reason,
      ).toBe("account-mismatch");
      expect(
        (yield* Effect.flip(
          api.readIssuesPage({ ...input, account: { ...account, credentialFingerprint: "old" } }),
        )).reason,
      ).toBe("credential-mismatch");
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/user"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fences foreign link hosts and refuses redirects without fetching them", () => {
    const { layer, requests } = harness((request) =>
      new URL(request.url).pathname.endsWith("/issues")
        ? json([issueJson()], {
            headers: { link: '<https://evil.example/repos/acme/web/issues?page=2>; rel="next"' },
          })
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect((yield* Effect.flip(api.readIssuesPage(input))).reason).toBe("invalid-response");
      expect(requests.every((request) => new URL(request.url).hostname === "api.github.com")).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses redirects without fetching their destination", () => {
    const { layer, requests } = harness(
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect((yield* Effect.flip(api.readIssuesPage(input))).reason).toBe("unavailable");
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => new URL(request.url).hostname === "api.github.com")).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("records a rate refusal and prevents the next background request", () => {
    const { layer, requests } = harness(() =>
      json(
        { message: "API rate limit exceeded" },
        { status: 429, headers: { "retry-after": "120" } },
      ),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      const limited = yield* Effect.flip(api.readIssuesPage(input));
      expect(limited.reason).toBe("rate-limited");
      expect(limited.retryAt).toBeDefined();
      const count = requests.length;
      expect((yield* Effect.flip(api.readIssuesPage(input))).reason).toBe("rate-paused");
      expect(requests).toHaveLength(count);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns authentication failure without a credential or network access", () => {
    const { layer, requests } = harness(() => json(repoJson()), false);
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      expect((yield* Effect.flip(api.readIssuesPage(input))).reason).toBe("authentication");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["git.acme.internal", "acme.ghe.com"])(
    "reuses configured enterprise API routing for %s",
    (host) => {
      const { layer, requests } = harness(() => json(repoJson(host)));
      return Effect.gen(function* () {
        const api = yield* GitHubIssueApi.GitHubIssueApi;
        const identity = yield* api.getAccount({ cwd: "/w", host });
        const result = yield* api.lookupRepository({
          cwd: "/w",
          account: identity,
          repository: "acme/web",
        });
        expect(result).toMatchObject({ status: "changed", data: { host, nodeId: "repo-1" } });
        expect(requests.map((request) => request.url)).toEqual([
          `${GitHubRequestPolicy.gitHubApiUrls(host).rest}/user`,
          `${GitHubRequestPolicy.gitHubApiUrls(host).rest}/repos/acme/web`,
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("bounds issue text and rejects invalid hosts without fetching", () => {
    const { layer, requests } = harness((request) =>
      new URL(request.url).pathname.endsWith("/issues")
        ? json([issueJson({ title: "t".repeat(5000), body: "b".repeat(33000) })])
        : json(repoJson()),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      const invalid = yield* Effect.flip(api.getAccount({ cwd: "/w", host: "github.com/evil" }));
      expect(invalid.reason).toBe("invalid-input");
      expect(
        (yield* Effect.flip(api.lookupRepository({ cwd: "/w", account, repository: "../web" })))
          .reason,
      ).toBe("invalid-input");
      expect(requests).toHaveLength(0);
      const page = yield* api.readIssuesPage(input);
      if (page.status !== "changed") return yield* Effect.die("expected changed page");
      expect(page.entries[0]?.title).toHaveLength(4000);
      expect(page.entries[0]?.body).toHaveLength(32000);
      expect(page.entries[0]).toMatchObject({ titleTruncated: true, bodyTruncated: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads comments with pinned issue identity and source revision", () => {
    const { layer } = harness((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/comments"))
        return json([
          {
            node_id: "comment-1",
            body: "Comment",
            updated_at: stamp,
            html_url: "https://github.com/acme/web/issues/1#issuecomment-1",
            issue_url: "https://api.github.com/repos/acme/web/issues/1",
          },
        ]);
      if (path.endsWith("/issues/1")) return json(issueJson());
      return json(repoJson());
    });
    return Effect.gen(function* () {
      const api = yield* GitHubIssueApi.GitHubIssueApi;
      const page = yield* api.readCommentsPage({
        cwd: "/w",
        account,
        repository,
        issue: { nodeId: "issue-1", number: 1 },
        expectedSourceRevision: stamp,
      });
      expect(page).toMatchObject({
        status: "changed",
        entries: [{ nodeId: "comment-1", body: "Comment" }],
        nextPage: null,
      });
    }).pipe(Effect.provide(layer));
  });
});
