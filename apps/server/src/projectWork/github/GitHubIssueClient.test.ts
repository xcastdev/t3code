import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as RateLimit from "../../sourceControl/SourceControlRateLimit.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Client from "./GitHubIssueClient.ts";

const account = { host: "github.com", credentialFingerprint: "fingerprint-a", nodeId: "U_a" };
const repository = { host: "github.com", nodeId: "R_a", nameWithOwner: "owner/repo" };
const input = { cwd: "/repo", account, repository, since: "2026-09-01T00:00:00Z", pageSize: 2 };
const rawRepository = {
  id: 1300192,
  node_id: "R_a",
  full_name: "owner/repo",
  url: "https://api.github.com/repos/owner/repo",
  html_url: "https://github.com/owner/repo",
  updated_at: "2026-09-01T00:00:00Z",
};
const issue = (number = 1) => ({
  node_id: `I_${number}`,
  number,
  title: "Title",
  body: "Body",
  state: "open",
  comments: 1,
  updated_at: "2026-09-02T00:00:00Z",
  closed_at: null,
  url: `https://api.github.com/repos/owner/repo/issues/${number}`,
  html_url: `https://github.com/owner/repo/issues/${number}`,
  repository_url: rawRepository.url,
});
const comment = () => ({
  node_id: "IC_1",
  body: "Comment",
  updated_at: "2026-09-02T00:00:00Z",
  html_url: "https://github.com/owner/repo/issues/1#issuecomment-1",
  issue_url: issue().url,
});
// gh prints the status line with LF and headers/separator with CRLF (api.go printHeaders).
function response(body: unknown, headers: Record<string, string> = {}, status = 200) {
  const encoded = JSON.stringify(body);
  return `HTTP/2.0 ${status} ${status === 304 ? "Not Modified" : "OK"}\n${Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("")}\r\n${status === 304 ? "" : encoded}`;
}
const output = (stdout: string, exit = 0): VcsProcess.VcsProcessOutput => ({
  stdout,
  stderr: exit ? "gh: HTTP 304\n" : "",
  exitCode: ChildProcessSpawner.ExitCode(exit),
  stdoutTruncated: false,
  stderrTruncated: false,
});
const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const dependencies = Layer.mergeAll(
  GitHubCli.layer.pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run }))),
  RateLimit.layer,
);
const layer = Client.layer.pipe(Layer.provideMerge(dependencies));
const pinned = {
  host: account.host,
  credentialFingerprint: account.credentialFingerprint,
  token: Redacted.make("synthetic-token"),
};
const provide = <A, E>(
  effect: Effect.Effect<A, E, Client.GitHubIssueClient | RateLimit.SourceControlRateLimit>,
) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.provideService(GitHubCli.PinnedGitHubCredential, pinned),
  );
function serve(data: string | ((endpoint: string) => string)) {
  run.mockImplementation((request) => {
    const endpoint = request.args.at(-1)!;
    const stdout =
      endpoint === "user"
        ? response({ node_id: account.nodeId })
        : endpoint === "repos/owner/repo"
          ? response(rawRepository)
          : endpoint === "repos/owner/repo/issues/1"
            ? response(issue())
            : typeof data === "string"
              ? data
              : data(endpoint);
    return Effect.succeed(
      output(stdout, Number(/^HTTP\/2\.0 (\d+)/u.exec(stdout)?.[1] ?? 200) >= 300 ? 1 : 0),
    );
  });
}
afterEach(() => run.mockReset());

describe("bounded GitHub issue transport", () => {
  it.effect("keeps continuation on a PR-only page and includes close/reopen source versions", () =>
    provide(
      Effect.gen(function* () {
        serve((endpoint) =>
          endpoint.includes("page=1")
            ? response(
                [
                  {
                    ...issue(1),
                    pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" },
                  },
                ],
                {
                  Link: '<https://api.github.com/repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=2>; rel="next"',
                },
              )
            : response([
                {
                  ...issue(2),
                  state: "closed",
                  closed_at: "2026-09-03T00:00:00Z",
                  updated_at: "2026-09-03T00:00:00Z",
                },
                { ...issue(3), updated_at: "2026-09-04T00:00:00Z" },
              ]),
        );
        const client = yield* Client.GitHubIssueClient;
        const first = yield* client.readIssuesPage(input);
        expect(first.status).toBe("changed");
        if (first.status !== "changed") return;
        expect(first.entries).toEqual([]);
        expect(first.nextPage).toBe(2);
        expect(first.rawEntryCount).toBe(1);
        if (first.nextPage === null) throw new Error("Expected page continuation.");
        const next = yield* client.readIssuesPage({ ...input, page: first.nextPage });
        if (next.status !== "changed") return;
        expect(next.entries.map((i) => [i.nodeId, i.state, i.updatedAt])).toEqual([
          ["I_2", "closed", "2026-09-03T00:00:00Z"],
          ["I_3", "open", "2026-09-04T00:00:00Z"],
        ]);
        for (const [request] of run.mock.calls) {
          expect(request.args).toContain("--include");
          expect(request.args).toContain("GET");
          expect(request.args).not.toContain("--paginate");
          expect(request.allowNonZeroExit).toBe(true);
          expect(request.maxOutputBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
          expect(request.args.join(" ")).not.toContain("synthetic-token");
        }
      }),
    ),
  );

  it.effect("distinguishes actual gh nonzero304 from an empty200 page", () =>
    provide(
      Effect.gen(function* () {
        serve(response(null, { Etag: '"v1"' }, 304));
        const client = yield* Client.GitHubIssueClient;
        expect(yield* client.readIssuesPage({ ...input, etag: '"v1"' })).toEqual({
          status: "not-modified",
          etag: '"v1"',
          repository,
        });
        expect(run.mock.calls.filter(([r]) => r.args.includes('If-None-Match: "v1"')).length).toBe(
          1,
        );
        serve(response([]));
        const empty = yield* client.readIssuesPage(input);
        expect(empty).toMatchObject({
          status: "changed",
          entries: [],
          nextPage: null,
          rawEntryCount: 0,
        });
      }),
    ),
  );

  it.effect("fails before CLI without a pinned credential or with wrong fingerprint", () =>
    Effect.gen(function* () {
      const client = yield* Client.GitHubIssueClient;
      expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
        "credential-missing",
      );
      expect(
        (yield* client.readIssuesPage(input).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            ...pinned,
            credentialFingerprint: "other",
          }),
          Effect.flip,
        )).reason,
      ).toBe("credential-mismatch");
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects an unexpected account even with matching fingerprint", () =>
    provide(
      Effect.gen(function* () {
        run.mockReturnValue(Effect.succeed(output(response({ node_id: "U_other" }))));
        const client = yield* Client.GitHubIssueClient;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
          "account-mismatch",
        );
        expect(run).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.effect("rejects repository rebind and accepts a verified rename", () =>
    provide(
      Effect.gen(function* () {
        serve(response([]));
        run.mockImplementationOnce(() =>
          Effect.succeed(output(response({ node_id: account.nodeId }))),
        );
        run.mockImplementationOnce(() =>
          Effect.succeed(output(response({ ...rawRepository, node_id: "R_other" }))),
        );
        const client = yield* Client.GitHubIssueClient;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
          "repository-mismatch",
        );
        run.mockImplementation((request) =>
          Effect.succeed(
            output(
              request.args.at(-1) === "user"
                ? response({ node_id: account.nodeId })
                : response({
                    ...rawRepository,
                    full_name: "owner/renamed",
                    url: "https://api.github.com/repos/owner/renamed",
                    html_url: "https://github.com/owner/renamed",
                  }),
            ),
          ),
        );
        const found = yield* client.lookupRepository({
          cwd: input.cwd,
          account,
          repository: "owner/repo",
          expectedRepositoryNodeId: "R_a",
        });
        expect(found).toMatchObject({
          status: "changed",
          data: { nodeId: "R_a", nameWithOwner: "owner/renamed" },
        });
      }),
    ),
  );

  for (const [name, data] of [
    ["invalid JSON", "HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n[{"],
    ["missing headers", "[]"],
    ["duplicate header", "HTTP/2.0 200 OK\nEtag: a\r\nEtag: b\r\n\r\n[]"],
    ["invalid issue", response([issue(), { ...issue(2), updated_at: "yesterday" }])],
    [
      "wrong repository URL",
      response([{ ...issue(), repository_url: "https://api.github.com/repos/other/repo" }]),
    ],
    [
      "malicious continuation",
      response([], { Link: '<https://evil.test/issues?page=2>; rel="next"' }),
    ],
  ]) {
    it.effect(`rejects ${name} without partial success`, () =>
      provide(
        Effect.gen(function* () {
          serve(data!);
          const client = yield* Client.GitHubIssueClient;
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
        }),
      ),
    );
  }

  it.effect(
    "bounds comments, preserves explicit truncation and rejects overflow or wrong issue",
    () =>
      provide(
        Effect.gen(function* () {
          serve(response([{ ...comment(), body: "x".repeat(32_001) }]));
          const client = yield* Client.GitHubIssueClient;
          const commentsInput = {
            cwd: input.cwd,
            account,
            repository,
            issue: { nodeId: "I_1", number: 1 },
            pageSize: 2,
          };
          const result = yield* client.readCommentsPage(commentsInput);
          if (result.status !== "changed") return;
          expect(result.entries[0]?.body.length).toBe(32_000);
          expect(result.entries[0]?.bodyTruncated).toBe(true);
          serve(response([comment(), comment(), comment()]));
          expect((yield* client.readCommentsPage(commentsInput).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
          expect(
            (yield* client
              .readCommentsPage({ ...commentsInput, issue: { number: 1, nodeId: "I_other" } })
              .pipe(Effect.flip)).reason,
          ).toBe("issue-mismatch");
        }),
      ),
  );
  it.effect("retains a newer concurrent rate pause and recovers after expiry", () =>
    provide(
      Effect.gen(function* () {
        const rates = yield* RateLimit.SourceControlRateLimit;
        const client = yield* Client.GitHubIssueClient;
        const key = { provider: "github", host: account.host } as const;
        serve(response([]));
        const normal = run.getMockImplementation()!;
        run.mockImplementation((request) =>
          request.args.at(-1)?.includes("issues?")
            ? rates.recordRateLimit({ ...key, lease: 0 }).pipe(Effect.as(output(response([]))))
            : normal(request),
        );
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-paused");
        expect((yield* rates.check(key).pipe(Effect.flip)).host).toBe(account.host);
        yield* TestClock.adjust("31 seconds");
        serve(response([]));
        expect((yield* client.readIssuesPage(input)).status).toBe("changed");
      }),
    ),
  );

  it.effect("sanitizes HTTP authentication/rate failures and pauses only their host", () =>
    provide(
      Effect.gen(function* () {
        const client = yield* Client.GitHubIssueClient;
        serve(response({ message: "do not expose synthetic-token" }, {}, 401));
        const auth = yield* client.readIssuesPage(input).pipe(Effect.flip);
        expect(auth.reason).toBe("authentication");
        expect(String(auth)).not.toContain("synthetic-token");
        serve(response({ message: "rate limit" }, { "Retry-After": "60" }, 429));
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        const calls = run.mock.calls.length;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-paused");
        expect(run).toHaveBeenCalledTimes(calls);
        const rates = yield* RateLimit.SourceControlRateLimit;
        expect(yield* rates.check({ provider: "github", host: "enterprise.test" })).toBe(0);
      }),
    ),
  );

  it.effect("rejects truncated/invalid UTF8 output even when the retained body is valid", () =>
    provide(
      Effect.gen(function* () {
        const client = yield* Client.GitHubIssueClient;
        for (const flag of [
          "stdoutTruncated",
          "stderrTruncated",
          "stdoutInvalidUtf8",
          "stderrInvalidUtf8",
        ]) {
          serve(response([]));
          const normal = run.getMockImplementation()!;
          run.mockImplementation((request) =>
            normal(request).pipe(Effect.map((result) => ({ ...result, [flag]: true }))),
          );
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
        }
      }),
    ),
  );

  it.effect(
    "rejects unsafe input, unsolicited304 and continuation beyond the finite page ceiling",
    () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          for (const changes of [
            { pageSize: 101 },
            { page: 0 },
            { page: 10001 },
            { etag: '"a"\r\nAuthorization: bad' },
          ]) {
            expect(
              (yield* client.readIssuesPage({ ...input, ...changes }).pipe(Effect.flip)).reason,
            ).toBe("invalid-input");
          }
          expect(run).not.toHaveBeenCalled();
          serve(response(null, {}, 304));
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
          serve(
            response([issue()], {
              Link: '<https://api.github.com/repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=10001>; rel="next"',
            }),
          );
          expect(
            (yield* client.readIssuesPage({ ...input, page: 10000 }).pipe(Effect.flip)).reason,
          ).toBe("page-limit");
        }),
      ),
  );

  it.effect(
    "truncates title/body explicitly while keeping close/reopen identity and updatedAt",
    () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          serve(
            response([
              {
                ...issue(),
                title: "t".repeat(4001),
                body: "b".repeat(32001),
                state: "closed",
                closed_at: "2026-09-03T00:00:00Z",
              },
            ]),
          );
          const closed = yield* client.readIssuesPage(input);
          serve(response([{ ...issue(), updated_at: "2026-09-04T00:00:00Z" }]));
          const reopened = yield* client.readIssuesPage(input);
          if (closed.status !== "changed" || reopened.status !== "changed") return;
          expect(closed.entries[0]).toMatchObject({
            titleTruncated: true,
            bodyTruncated: true,
            state: "closed",
          });
          expect(closed.entries[0]?.title.length).toBe(4000);
          expect(closed.entries[0]?.body.length).toBe(32000);
          expect(reopened.entries[0]).toMatchObject({
            nodeId: closed.entries[0]?.nodeId,
            state: "open",
            closedAt: null,
            updatedAt: "2026-09-04T00:00:00Z",
          });
        }),
      ),
  );
  it.effect("reads real VcsProcess nonzero304 through the full GitHubCli consumer", () =>
    Effect.gen(function* () {
      const runner = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>((request) => {
        const endpoint = request.args.at(-1);
        const stdout =
          endpoint === "user"
            ? response({ node_id: account.nodeId })
            : endpoint === "repos/owner/repo"
              ? response(rawRepository)
              : response(null, { Etag: '"v1"' }, 304);
        return Effect.succeed({
          ...output(stdout),
          code: ChildProcessSpawner.ExitCode(endpoint?.includes("issues?") ? 1 : 0),
          timedOut: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      });
      const vcs = yield* VcsProcess.make.pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: runner }),
        ),
      );
      const gh = yield* GitHubCli.make.pipe(Effect.provideService(VcsProcess.VcsProcess, vcs));
      const rates = yield* RateLimit.make;
      const client = yield* Client.make.pipe(
        Effect.provideService(GitHubCli.GitHubCli, gh),
        Effect.provideService(RateLimit.SourceControlRateLimit, rates),
      );
      expect(yield* client.readIssuesPage({ ...input, etag: '"v1"' })).toEqual({
        status: "not-modified",
        etag: '"v1"',
        repository,
      });
      expect(runner.mock.calls.at(-1)?.[0].args).toEqual([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        'If-None-Match: "v1"',
        "repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=1",
      ]);
    }).pipe(Effect.provideService(GitHubCli.PinnedGitHubCredential, pinned)),
  );

  it.effect("keeps concurrent same-host accounts and enterprise credentials isolated", () =>
    provide(
      Effect.gen(function* () {
        const accounts = [
          account,
          { ...account, nodeId: "U_b", credentialFingerprint: "fingerprint-b" },
          {
            ...account,
            host: "git.enterprise.test",
            nodeId: "U_e",
            credentialFingerprint: "fingerprint-e",
          },
        ];
        const credentials = accounts.map((a) => ({
          host: a.host,
          credentialFingerprint: a.credentialFingerprint,
          token: Redacted.make(a.nodeId),
        }));
        run.mockImplementation((request) => {
          const host = request.args[2]!;
          const user = request.env?.GH_TOKEN;
          const origin =
            host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
          const endpoint = request.args.at(-1)!;
          const body =
            endpoint === "user"
              ? { node_id: user }
              : endpoint.includes("issues?")
                ? [
                    {
                      ...issue(),
                      node_id: `I_${user}`,
                      title: String(user),
                      url: `${origin}/repos/owner/repo/issues/1`,
                      repository_url: `${origin}/repos/owner/repo`,
                      html_url: `https://${host}/owner/repo/issues/1`,
                    },
                  ]
                : {
                    ...rawRepository,
                    url: `${origin}/repos/owner/repo`,
                    html_url: `https://${host}/owner/repo`,
                  };
          return Effect.succeed(output(response(body)));
        });
        const client = yield* Client.GitHubIssueClient;
        const pages = yield* Effect.all(
          accounts.map((a, index) =>
            client
              .readIssuesPage({ ...input, account: a, repository: { ...repository, host: a.host } })
              .pipe(Effect.provideService(GitHubCli.PinnedGitHubCredential, credentials[index]!)),
          ),
          { concurrency: 3 },
        );
        expect(
          pages.map((page) => (page.status === "changed" ? page.entries[0]?.title : null)),
        ).toEqual(["U_a", "U_b", "U_e"]);
        for (const [request] of run.mock.calls) {
          expect(request.env?.GH_HOST).toBe(request.args[2]);
          expect(request.env?.GH_DEBUG).toBe("");
          expect(request.args).not.toContain(request.env?.GH_TOKEN);
        }
      }),
    ),
  );

  it.effect("uses canonical rename identity for issue/comment reads and continuation", () =>
    provide(
      Effect.gen(function* () {
        const canonical = {
          ...rawRepository,
          full_name: "owner/renamed",
          url: "https://api.github.com/repos/owner/renamed",
          html_url: "https://github.com/owner/renamed",
        };
        const renamedIssue = {
          ...issue(),
          url: `${canonical.url}/issues/1`,
          html_url: `${canonical.html_url}/issues/1`,
          repository_url: canonical.url,
        };
        run.mockImplementation((request) => {
          const endpoint = request.args.at(-1)!;
          const body =
            endpoint === "user"
              ? { node_id: account.nodeId }
              : endpoint.includes("comments?")
                ? [
                    {
                      ...comment(),
                      issue_url: renamedIssue.url,
                      html_url: `${renamedIssue.html_url}#issuecomment-1`,
                    },
                  ]
                : endpoint.includes("issues?")
                  ? [renamedIssue]
                  : endpoint.endsWith("issues/1")
                    ? renamedIssue
                    : canonical;
          return Effect.succeed(output(response(body)));
        });
        const client = yield* Client.GitHubIssueClient;
        expect((yield* client.readIssuesPage(input)).repository).toEqual({
          ...repository,
          nameWithOwner: "owner/renamed",
        });
        expect(
          (yield* client.readCommentsPage({
            cwd: input.cwd,
            account,
            repository,
            issue: { nodeId: "I_1", number: 1 },
          })).repository.nameWithOwner,
        ).toBe("owner/renamed");
      }),
    ),
  );

  it.effect(
    "verifies issue identity unconditionally before comment304 and rejects other-issue comments",
    () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          const commentsInput = {
            cwd: input.cwd,
            account,
            repository,
            issue: { nodeId: "I_1", number: 1 },
            etag: '"comments-v1"',
          };
          serve(response(null, { Etag: '"comments-v1"' }, 304));
          expect((yield* client.readCommentsPage(commentsInput)).status).toBe("not-modified");
          const issueRequest = run.mock.calls.find(
            ([request]) => request.args.at(-1) === "repos/owner/repo/issues/1",
          )?.[0];
          expect(issueRequest?.args.join(" ")).not.toContain("If-None-Match");
          serve(response([{ ...comment(), issue_url: issue(2).url }]));
          expect((yield* client.readCommentsPage(commentsInput).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
        }),
      ),
  );

  it.effect(
    "checks repository identity before conditional lookup and permits first discovery only without etag",
    () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          const lookup = { cwd: input.cwd, account, repository: "owner/repo" };
          expect(
            (yield* client.lookupRepository({ ...lookup, etag: '"v1"' }).pipe(Effect.flip)).reason,
          ).toBe("invalid-input");
          expect(run).not.toHaveBeenCalled();
          serve(response([]));
          expect((yield* client.lookupRepository(lookup)).status).toBe("changed");
          const normal = run.getMockImplementation()!;
          run.mockImplementation((request) =>
            request.args.some((arg) => arg.startsWith("If-None-Match:"))
              ? Effect.succeed(output(response(null, { Etag: '"v1"' }, 304), 1))
              : normal(request),
          );
          expect(
            yield* client.lookupRepository({
              ...lookup,
              expectedRepositoryNodeId: "R_a",
              etag: '"v1"',
            }),
          ).toEqual({ status: "not-modified", etag: '"v1"' });
          expect(
            (yield* client
              .lookupRepository({ ...lookup, expectedRepositoryNodeId: "R_wrong", etag: '"v1"' })
              .pipe(Effect.flip)).reason,
          ).toBe("repository-mismatch");
        }),
      ),
  );

  it.effect("detects a repository rebound during a page without returning its entries", () =>
    provide(
      Effect.gen(function* () {
        serve(response([issue()]));
        const normal = run.getMockImplementation()!;
        let repositoryReads = 0;
        run.mockImplementation((request) =>
          request.args.at(-1) === "repos/owner/repo" && ++repositoryReads === 2
            ? Effect.succeed(output(response({ ...rawRepository, node_id: "R_rebound" })))
            : normal(request),
        );
        const client = yield* Client.GitHubIssueClient;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
          "repository-mismatch",
        );
      }),
    ),
  );

  it.effect("recognizes secondary403 rate failures without quota or retry headers", () =>
    provide(
      Effect.gen(function* () {
        serve(response({ message: "You have exceeded a secondary rate limit." }, {}, 403));
        const client = yield* Client.GitHubIssueClient;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-paused");
      }),
    ),
  );

  const nextUrl =
    "https://api.github.com/repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=2";
  for (const { name, link } of [
    { name: "wrong next page", link: `<${nextUrl.replace("page=2", "page=3")}>; rel="next"` },
    { name: "changed query", link: `<${nextUrl.replace("state=all", "state=open")}>; rel="next"` },
    { name: "wrong endpoint", link: `<${nextUrl.replace("/issues?", "/comments?")}>; rel="next"` },
    { name: "duplicate query", link: `<${nextUrl}&page=2>; rel="next"` },
    { name: "duplicate next relation", link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="next"` },
    { name: "last without next", link: `<${nextUrl}>; rel="last"` },
    { name: "unknown relation", link: `<${nextUrl}>; rel="alternate"` },
    {
      name: "remote credentials",
      link: `<${nextUrl.replace("https://", "https://user:password@")} >; rel="next"`,
    },
  ]) {
    it.effect(`rejects malformed continuation: ${name}`, () =>
      provide(
        Effect.gen(function* () {
          serve(response([issue()], { Link: link }));
          const client = yield* Client.GitHubIssueClient;
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
        }),
      ),
    );
  }

  it.effect("returns bounded comment continuation with its source version", () =>
    provide(
      Effect.gen(function* () {
        const client = yield* Client.GitHubIssueClient;
        serve(
          response([comment()], {
            Etag: 'W/"comments-v2"',
            Link: '<https://api.github.com/repos/owner/repo/issues/1/comments?per_page=2&page=2>; rel="next", <https://api.github.com/repos/owner/repo/issues/1/comments?per_page=2&page=2>; rel="last"',
          }),
        );
        const page = yield* client.readCommentsPage({
          cwd: input.cwd,
          account,
          repository,
          issue: { nodeId: "I_1", number: 1 },
          pageSize: 2,
        });
        expect(page).toMatchObject({
          status: "changed",
          nextPage: 2,
          etag: 'W/"comments-v2"',
          rawEntryCount: 1,
          entries: [{ nodeId: "IC_1", updatedAt: "2026-09-02T00:00:00Z" }],
        });
      }),
    ),
  );

  it.effect(
    "rejects impossible dates, excess issue rows, bad304 bodies and unexpected process status",
    () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          for (const data of [
            response([{ ...issue(), updated_at: "2026-09-31T00:00:00Z" }]),
            response([issue(), issue(2), issue(3)]),
          ]) {
            serve(data);
            expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
              "invalid-response",
            );
          }
          serve(response(null, {}, 304) + "[]");
          expect(
            (yield* client.readIssuesPage({ ...input, etag: '"v1"' }).pipe(Effect.flip)).reason,
          ).toBe("invalid-response");
          serve(response([]));
          const normal = run.getMockImplementation()!;
          run.mockImplementation((request) =>
            normal(request).pipe(
              Effect.map((result) => ({ ...result, exitCode: ChildProcessSpawner.ExitCode(2) })),
            ),
          );
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
        }),
      ),
  );
  it.effect(
    "P5-T1 accepts verified numeric issues/comments Link routes without exposing or executing them",
    () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          serve(
            response([issue()], {
              Link: '<https://api.github.com/repositories/1300192/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=2>; rel="next"',
            }),
          );
          const first = yield* client.readIssuesPage(input);
          expect(first).toMatchObject({ status: "changed", nextPage: 2, repository });
          expect(first.repository).toEqual(repository);
          serve(response([issue(2)]));
          expect((yield* client.readIssuesPage({ ...input, page: 2 })).status).toBe("changed");
          serve(
            response([comment()], {
              Link: '<https://api.github.com/repositories/1300192/issues/1/comments?per_page=2&page=2>; rel="next"',
            }),
          );
          expect(
            yield* client.readCommentsPage({
              cwd: input.cwd,
              account,
              repository,
              issue: { nodeId: "I_1", number: 1 },
              pageSize: 2,
            }),
          ).toMatchObject({ status: "changed", nextPage: 2, repository });
          const lookup = yield* client.lookupRepository({
            cwd: input.cwd,
            account,
            repository: "owner/repo",
            expectedRepositoryNodeId: "R_a",
          });
          if (lookup.status === "changed") {
            expect(Object.keys(lookup).sort()).toEqual(["data", "etag", "status"]);
            expect(Object.keys(lookup.data).sort()).toEqual([
              "host",
              "nameWithOwner",
              "nodeId",
              "updatedAt",
              "url",
            ]);
          }
          expect(
            run.mock.calls.every(([request]) => !request.args.at(-1)?.includes("repositories/")),
          ).toBe(true);
        }),
      ),
  );

  it.effect("P5-T1 validates enterprise numeric pagination against the verified API prefix", () =>
    provide(
      Effect.gen(function* () {
        const host = "git.enterprise.test";
        const prefix = `https://${host}/api/v3`;
        const enterpriseAccount = { ...account, host };
        const enterpriseRepository = { ...repository, host };
        const repo = {
          ...rawRepository,
          url: `${prefix}/repos/owner/repo`,
          html_url: `https://${host}/owner/repo`,
        };
        run.mockImplementation((request) => {
          const endpoint = request.args.at(-1)!;
          const headers: Record<string, string> = endpoint.includes("issues?")
            ? {
                Link: `<${prefix}/repositories/1300192/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=2>; rel="next"`,
              }
            : endpoint.includes("comments?")
              ? {
                  Link: `<${prefix}/repositories/1300192/issues/1/comments?per_page=2&page=2>; rel="next"`,
                }
              : {};
          const record = {
            ...issue(),
            url: `${repo.url}/issues/1`,
            repository_url: repo.url,
            html_url: `${repo.html_url}/issues/1`,
          };
          const body =
            endpoint === "user"
              ? { node_id: account.nodeId }
              : endpoint.includes("comments?")
                ? [
                    {
                      ...comment(),
                      issue_url: record.url,
                      html_url: `${record.html_url}#issuecomment-1`,
                    },
                  ]
                : endpoint.includes("issues?")
                  ? [record]
                  : endpoint.endsWith("issues/1")
                    ? record
                    : repo;
          return Effect.succeed(output(response(body, headers)));
        });
        const client = yield* Client.GitHubIssueClient;
        const read = Effect.gen(function* () {
          expect(
            yield* client.readIssuesPage({
              ...input,
              account: enterpriseAccount,
              repository: enterpriseRepository,
            }),
          ).toMatchObject({ status: "changed", nextPage: 2 });
          expect(
            yield* client.readCommentsPage({
              cwd: input.cwd,
              account: enterpriseAccount,
              repository: enterpriseRepository,
              issue: { nodeId: "I_1", number: 1 },
              pageSize: 2,
            }),
          ).toMatchObject({ status: "changed", nextPage: 2 });
        });
        yield* read.pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, { ...pinned, host }),
        );
      }),
    ),
  );

  it.effect("P5-T1 rejects other numeric IDs, endpoints and query identities", () =>
    provide(
      Effect.gen(function* () {
        const client = yield* Client.GitHubIssueClient;
        const valid =
          "https://api.github.com/repositories/1300192/issues?state=all&sort=updated&direction=asc&since=2026-09-01T00%3A00%3A00Z&per_page=2&page=2";
        for (const url of [
          valid.replace("1300192", "1300193"),
          valid.replace("/issues?", "/issues/1/comments?"),
          valid.replace("direction=asc", "direction=desc"),
          valid + "&page=2",
          valid.replace("/repositories/", "/api/v3/repositories/"),
        ]) {
          serve(response([issue()], { Link: `<${url}>; rel="next"` }));
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "invalid-response",
          );
        }
        serve(
          response([comment()], {
            Link: '<https://api.github.com/repositories/1300193/issues/1/comments?per_page=2&page=2>; rel="next"',
          }),
        );
        expect(
          (yield* client
            .readCommentsPage({
              cwd: input.cwd,
              account,
              repository,
              issue: { nodeId: "I_1", number: 1 },
              pageSize: 2,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-response");
      }),
    ),
  );

  for (const malformedBody of ["{}", "{"]) {
    it.effect(`P5-T2 pauses on decisive headers before decoding ${malformedBody}`, () =>
      provide(
        Effect.gen(function* () {
          const client = yield* Client.GitHubIssueClient;
          const now = yield* Clock.currentTimeMillis;
          serve(
            response({}, { "X-RateLimit-Remaining": "0", "Retry-After": "60" }, 403).slice(0, -2) +
              malformedBody,
          );
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "rate-limited",
          );
          const count = run.mock.calls.length;
          const paused = yield* client.readIssuesPage(input).pipe(Effect.flip);
          expect(paused).toMatchObject({ reason: "rate-paused", retryAt: now + 60000 });
          expect(run).toHaveBeenCalledTimes(count);
        }),
      ),
    );
  }

  it.effect("P5-T2 respects header-only Retry-After and quota-reset guidance", () =>
    provide(
      Effect.gen(function* () {
        const client = yield* Client.GitHubIssueClient;
        const now = yield* Clock.currentTimeMillis;
        serve(response({}, { "Retry-After": "90" }, 403));
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).retryAt).toBe(now + 90000);
        yield* TestClock.adjust("91 seconds");
        const later = yield* Clock.currentTimeMillis;
        serve(
          response(
            {},
            { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((later + 300000) / 1000) },
            403,
          ),
        );
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).retryAt).toBe(
          later + 300000,
        );
      }),
    ),
  );

  it.effect("P5-T3 preserves one-minute minimum, later backoff and success reset", () =>
    provide(
      Effect.gen(function* () {
        const client = yield* Client.GitHubIssueClient;
        const rates = yield* RateLimit.SourceControlRateLimit;
        const key = { provider: "github", host: account.host } as const;
        for (const [index, delay] of [60000, 60000, 120000, 240000].entries()) {
          run.mockReturnValue(
            Effect.succeed(output(response({ message: "secondary rate limit" }, {}, 403), 1)),
          );
          const now = yield* Clock.currentTimeMillis;
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "rate-limited",
          );
          expect(yield* rates.check(key, { allowPaused: true })).toBe(index + 1);
          const paused = yield* rates.check(key).pipe(Effect.flip);
          expect(paused.retryAt).toBe(now + delay);
          const calls = run.mock.calls.length;
          yield* TestClock.adjust(delay - 1000);
          expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe(
            "rate-paused",
          );
          expect(run).toHaveBeenCalledTimes(calls);
          yield* TestClock.adjust("1001 millis");
        }
        serve(response([]));
        expect((yield* client.readIssuesPage(input)).status).toBe("changed");
        run.mockReturnValue(
          Effect.succeed(output(response({ message: "secondary rate limit" }, {}, 403), 1)),
        );
        const now = yield* Clock.currentTimeMillis;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect((yield* rates.check(key).pipe(Effect.flip)).retryAt).toBe(now + 60000);
      }),
    ),
  );

  it.effect("P5-T3 floor extension preserves a newer concurrent pause and generation", () =>
    provide(
      Effect.gen(function* () {
        const rates = yield* RateLimit.SourceControlRateLimit;
        const key = { provider: "github", host: account.host } as const;
        const now = yield* Clock.currentTimeMillis;
        run.mockImplementation(() =>
          rates
            .recordRateLimit({ ...key, lease: 0, retryAt: now + 300000 })
            .pipe(Effect.as(output(response({ message: "secondary rate limit" }, {}, 403), 1))),
        );
        const client = yield* Client.GitHubIssueClient;
        expect((yield* client.readIssuesPage(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect(yield* rates.check(key, { allowPaused: true })).toBe(1);
        expect((yield* rates.check(key).pipe(Effect.flip)).retryAt).toBe(now + 300000);
      }),
    ),
  );
});
