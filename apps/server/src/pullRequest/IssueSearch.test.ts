import { describe, expect, it } from "vite-plus/test";

import { decodeIssueSearchResult, issueSearchArgs } from "./IssueSearch.ts";

describe("decodeIssueSearchResult", () => {
  it("keeps GitHub issues and excludes pull requests returned by the issues API", () => {
    expect(
      decodeIssueSearchResult(
        JSON.stringify({
          items: [
            {
              number: 42,
              title: "Fix login",
              html_url: "https://github.com/acme/app/issues/42",
              state: "open",
            },
            {
              number: 43,
              title: "A pull request",
              html_url: "https://github.com/acme/app/pull/43",
              state: "open",
              pull_request: {},
            },
          ],
        }),
        "github",
      ).entries,
    ).toEqual([
      {
        number: 42,
        title: "Fix login",
        url: "https://github.com/acme/app/issues/42",
        state: "open",
      },
    ]);
  });

  it("uses GitLab issue IIDs for project references", () => {
    expect(
      decodeIssueSearchResult(
        JSON.stringify([
          {
            iid: 7,
            title: "Improve docs",
            web_url: "http://gitlab.example/acme/app/-/issues/7",
            state: "opened",
          },
        ]),
        "gitlab",
      ).entries,
    ).toEqual([
      {
        number: 7,
        title: "Improve docs",
        url: "http://gitlab.example/acme/app/-/issues/7",
        state: "open",
      },
    ]);
  });

  it("targets the selected host and repository for exact and text searches", () => {
    expect(issueSearchArgs("github", "github.com", "acme/app", "42")).toEqual([
      "api",
      "--hostname",
      "github.com",
      "repos/acme/app/issues/42",
    ]);
    expect(issueSearchArgs("gitlab", "gitlab.example", "team/app", "login bug")).toEqual([
      "api",
      "--hostname",
      "gitlab.example",
      "projects/team%2Fapp/issues?scope=all&state=all&per_page=30&search=login%20bug",
    ]);
  });
});
