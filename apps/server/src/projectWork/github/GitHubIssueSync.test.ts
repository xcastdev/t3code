import { describe, expect, it } from "vite-plus/test";
import { acceptPage, planPage, type IssueSyncRequest } from "./GitHubIssueSync.ts";
import type { GitHubIssuePage, GitHubIssueRecord } from "./GitHubIssueClient.ts";

const repository = { host: "github.com", nodeId: "R_1", nameWithOwner: "owner/repo" };
const account = { host: "github.com", nodeId: "U_1", credentialFingerprint: "opaque-generation-1" };
const query = {
  since: "2026-09-01T00:00:00Z",
  pageSize: 2,
  state: "all",
  sort: "updated",
  direction: "asc",
} as const;
const fence = { generation: 1, leaseId: "request-1" };
const request: IssueSyncRequest = { repository, account, query, ...fence, page: 1 };
const observedAt = "2026-09-02T00:00:00Z";
const issue: GitHubIssueRecord = {
  nodeId: "I_1",
  number: 1,
  title: "First",
  titleTruncated: false,
  body: "Description",
  bodyTruncated: false,
  state: "open",
  updatedAt: observedAt,
  closedAt: null,
  url: "https://github.com/owner/repo/issues/1",
  commentCount: 0,
};
const changed: GitHubIssuePage<GitHubIssueRecord> = {
  status: "changed",
  repository,
  etag: '"page-1"',
  entries: [issue],
  nextPage: 2,
  rawEntryCount: 2,
};
const notModified: GitHubIssuePage<GitHubIssueRecord> = {
  status: "not-modified",
  repository,
  etag: '"page-1"',
};
function snapshot() {
  const result = acceptPage({ request, response: changed, currentFence: fence, observedAt });
  if (result.status !== "accepted") throw new Error("Fixture page rejected");
  return { ...result.snapshot, commitId: "durable-page-commit" };
}

describe("pure issue page planning", () => {
  it("plans an unconditional bounded page before a matching committed snapshot exists", () => {
    expect(planPage({ request, currentFence: fence })).toEqual({ status: "ready", request });
  });
  it("reuses only the exact committed page etag", () => {
    expect(
      planPage({ request, currentFence: fence, priorCommittedSnapshot: snapshot() }),
    ).toMatchObject({ status: "ready", etag: '"page-1"' });
  });
  for (const [label, revised] of [
    [
      "host",
      {
        ...request,
        repository: { ...repository, host: "git.example.com" },
        account: { ...account, host: "git.example.com" },
      },
    ],
    ["immutable repository", { ...request, repository: { ...repository, nodeId: "R_2" } }],
    [
      "repository route after rename",
      { ...request, repository: { ...repository, nameWithOwner: "new/repo" } },
    ],
    [
      "opaque credential generation",
      { ...request, account: { ...account, credentialFingerprint: "opaque-generation-2" } },
    ],
    ["query window", { ...request, query: { ...query, since: "2026-08-01T00:00:00Z" } }],
    ["page size", { ...request, query: { ...query, pageSize: 1 } }],
    ["page", { ...request, page: 2 }],
  ] as const) {
    it(`does not send an etag across a changed ${label}`, () => {
      expect(
        planPage({ request: revised, currentFence: fence, priorCommittedSnapshot: snapshot() }),
      ).toEqual({ status: "ready", request: revised });
      expect(
        acceptPage({
          request: revised,
          response: { ...notModified, repository: revised.repository },
          currentFence: fence,
          priorCommittedSnapshot: snapshot(),
          observedAt,
        }),
      ).toMatchObject({ status: "rejected" });
    });
  }
  it("rejects stale generation or request lease before planning or accepting data", () => {
    for (const currentFence of [
      { ...fence, generation: 2 },
      { ...fence, leaseId: "new-request" },
    ]) {
      expect(planPage({ request, currentFence })).toEqual({
        status: "rejected",
        reason: "stale-fence",
      });
      expect(acceptPage({ request, response: changed, currentFence, observedAt })).toEqual({
        status: "rejected",
        reason: "stale-fence",
      });
    }
  });
  it("accepts 304 only with its exact prior committed snapshot and etag", () => {
    expect(
      acceptPage({ request, response: notModified, currentFence: fence, observedAt }),
    ).toMatchObject({ status: "rejected" });
    const priorCommittedSnapshot = snapshot();
    const result = acceptPage({
      request,
      response: notModified,
      sentEtag: '"page-1"',
      currentFence: fence,
      priorCommittedSnapshot,
      observedAt,
    });
    expect(result).toMatchObject({
      status: "accepted",
      snapshot: { entries: [issue], nextPage: 2, etag: '"page-1"' },
      progress: { nextPage: 2, overlapSince: query.since },
    });
    expect(
      acceptPage({
        request,
        response: { ...notModified, etag: '"different"' },
        currentFence: fence,
        priorCommittedSnapshot,
        observedAt,
      }),
    ).toMatchObject({ status: "rejected" });
  });
  it("rejects a 304 without evidence that the exact conditional etag was sent", () => {
    const priorCommittedSnapshot = snapshot();
    for (const sentEtag of [undefined, '"other"']) {
      expect(
        acceptPage({
          request,
          response: notModified,
          currentFence: fence,
          priorCommittedSnapshot,
          observedAt,
          ...(sentEtag === undefined ? {} : { sentEtag }),
        }),
      ).toEqual({ status: "rejected", reason: "snapshot-mismatch" });
    }
    expect(
      acceptPage({
        request,
        response: { ...notModified, etag: null },
        sentEtag: '"page-1"',
        currentFence: fence,
        priorCommittedSnapshot,
        observedAt,
      }),
    ).toMatchObject({ status: "accepted", snapshot: { etag: '"page-1"' } });
  });
  it("invalidates snapshots from an older sync generation", () => {
    const revised = { ...request, generation: 2 };
    const currentFence = { ...fence, generation: 2 };
    const priorCommittedSnapshot = snapshot();
    expect(planPage({ request: revised, currentFence, priorCommittedSnapshot })).toEqual({
      status: "ready",
      request: revised,
    });
    expect(
      acceptPage({
        request: revised,
        response: notModified,
        sentEtag: '"page-1"',
        currentFence,
        priorCommittedSnapshot,
        observedAt,
      }),
    ).toMatchObject({ status: "rejected" });
  });
  it("rejects same-repository account switching even with an advanced generation", () => {
    const priorCommittedSnapshot = snapshot();
    for (const generation of [1, 2]) {
      const revised = { ...request, generation, account: { ...account, nodeId: "U_2" } };
      const currentFence = { ...fence, generation };
      expect(planPage({ request: revised, currentFence, priorCommittedSnapshot })).toEqual({
        status: "rejected",
        reason: "account-mismatch",
      });
      expect(
        acceptPage({
          request: revised,
          response: changed,
          currentFence,
          priorCommittedSnapshot,
          observedAt,
        }),
      ).toEqual({ status: "rejected", reason: "account-mismatch" });
    }
  });
  it("permits same-account credential rotation only as a fresh unconditional read", () => {
    const revised = {
      ...request,
      account: { ...account, credentialFingerprint: "opaque-generation-2" },
    };
    const priorCommittedSnapshot = snapshot();
    expect(planPage({ request: revised, currentFence: fence, priorCommittedSnapshot })).toEqual({
      status: "ready",
      request: revised,
    });
    expect(
      acceptPage({
        request: revised,
        response: changed,
        currentFence: fence,
        priorCommittedSnapshot,
        observedAt,
      }),
    ).toMatchObject({ status: "accepted", snapshot: { account: revised.account } });
  });
  it("preserves continuation through PR-only pages and the same window across multiple pages", () => {
    const first = acceptPage({
      request,
      response: { ...changed, entries: [] },
      currentFence: fence,
      observedAt,
    });
    expect(first).toMatchObject({
      status: "accepted",
      snapshot: { entries: [], rawEntryCount: 2 },
      progress: { nextPage: 2, overlapSince: query.since },
    });
    const second = acceptPage({
      request: { ...request, page: 2 },
      response: { ...changed, nextPage: null },
      currentFence: fence,
      observedAt,
    });
    expect(second).toMatchObject({
      status: "accepted",
      progress: { nextPage: null, overlapSince: query.since },
    });
  });
  it("accepts canonical rename on changed reads while retaining immutable identity", () => {
    expect(
      acceptPage({
        request,
        response: {
          ...changed,
          repository: { ...repository, nameWithOwner: "new/repo" },
          entries: [{ ...issue, url: "https://github.com/new/repo/issues/1" }],
        },
        currentFence: fence,
        observedAt,
      }),
    ).toMatchObject({
      status: "accepted",
      snapshot: { repository: { ...repository, nameWithOwner: "new/repo" } },
    });
  });
  it("rejects malformed, oversized, foreign and nonsequential page responses", () => {
    for (const response of [
      { ...changed, repository: { ...repository, nodeId: "R_2" } },
      { ...changed, entries: [issue, issue, issue] },
      { ...changed, entries: [issue, issue] },
      { ...changed, rawEntryCount: 0 },
      { ...changed, nextPage: 3 },
      { ...changed, nextPage: 1 },
      { ...changed, entries: [{ ...issue, url: "https://github.com/other/repo/issues/1" }] },
    ])
      expect(acceptPage({ request, response, currentFence: fence, observedAt })).toMatchObject({
        status: "rejected",
      });
  });
  it("rejects invalid page bounds, queries and malformed committed snapshots", () => {
    for (const invalid of [
      { ...request, page: 0 },
      { ...request, page: 10_001 },
      { ...request, query: { ...query, pageSize: 101 } },
      { ...request, query: { ...query, since: "invalid" } },
    ]) {
      expect(planPage({ request: invalid, currentFence: fence })).toMatchObject({
        status: "rejected",
      });
    }
    expect(
      planPage({
        request,
        currentFence: fence,
        priorCommittedSnapshot: { ...snapshot(), commitId: "" },
      }),
    ).toMatchObject({ status: "rejected" });
  });
  it("returns new values without mutating the trusted prior snapshot or input", () => {
    const priorCommittedSnapshot = snapshot();
    Object.freeze(priorCommittedSnapshot.entries);
    Object.freeze(priorCommittedSnapshot);
    expect(
      acceptPage({
        request,
        response: notModified,
        sentEtag: '"page-1"',
        currentFence: fence,
        priorCommittedSnapshot,
        observedAt,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(priorCommittedSnapshot.commitId).toBe("durable-page-commit");
    expect(request).not.toHaveProperty("etag");
  });
});
