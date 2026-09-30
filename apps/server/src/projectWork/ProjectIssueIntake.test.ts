import { ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "@effect/vitest";
import { mergeIssueObservation, selectIssueProject } from "./ProjectIssueIntake.ts";
import * as Client from "./github/GitHubIssueClient.ts";
import { acceptPage, planPage } from "./github/GitHubIssueSync.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as RateLimit from "../sourceControl/SourceControlRateLimit.ts";

const repository = { host: "github.com", nodeId: "R_1", nameWithOwner: "owner/repo" };
const issue = {
  nodeId: "I_1",
  number: 1,
  title: "Issue",
  titleTruncated: false,
  body: "Body",
  bodyTruncated: false,
  state: "open" as const,
  updatedAt: "2026-09-02T00:00:00Z",
  closedAt: null,
  url: "https://github.com/owner/repo/issues/1",
  commentCount: 0,
};
const input = {
  projectId: ProjectId.make("project-a"),
  recordId: "intake-a",
  repository,
  issue,
  observedAt: "2026-09-03T00:00:00Z",
};
function record() {
  const result = mergeIssueObservation(input);
  if (result.status !== "changed") throw new Error("Fixture issue rejected");
  return result.record;
}

const clientObservation = Effect.fn("clientObservation")(function* (
  title: string,
  nameWithOwner = repository.nameWithOwner,
) {
  const account = {
    host: repository.host,
    nodeId: "U_1",
    credentialFingerprint: "synthetic-generation",
  };
  const currentRepository = { ...repository, nameWithOwner };
  const fence = { generation: 1, leaseId: "synthetic-read" };
  const request = {
    ...fence,
    repository: currentRepository,
    account,
    page: 1,
    query: {
      since: "2026-09-01T00:00:00Z",
      pageSize: 2,
      state: "all",
      sort: "updated",
      direction: "asc",
    },
  };
  const planned = planPage({ request, currentFence: fence });
  if (planned.status !== "ready") throw new Error("Synthetic read rejected");
  const rawRepository = {
    id: 1,
    node_id: repository.nodeId,
    full_name: nameWithOwner,
    url: `https://api.github.com/repos/${nameWithOwner}`,
    html_url: `https://github.com/${nameWithOwner}`,
    updated_at: request.query.since,
  };
  const rawIssue = {
    node_id: issue.nodeId,
    number: issue.number,
    title,
    body: issue.body,
    state: issue.state,
    comments: 0,
    updated_at: issue.updatedAt,
    closed_at: null,
    url: `${rawRepository.url}/issues/${issue.number}`,
    html_url: `${rawRepository.html_url}/issues/${issue.number}`,
    repository_url: rawRepository.url,
  };
  const gh = Layer.mock(GitHubCli.GitHubCli)({
    execute: (call) => {
      const endpoint = call.args.at(-1);
      const data =
        endpoint === "user"
          ? { node_id: account.nodeId }
          : endpoint === `repos/${nameWithOwner}`
            ? rawRepository
            : [rawIssue];
      return Effect.succeed({
        stdout: `HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`,
        stderr: "",
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  });
  const page = yield* Effect.gen(function* () {
    const client = yield* Client.make;
    return yield* client.readIssuesPage({
      cwd: "/synthetic-intake",
      account,
      repository: currentRepository,
      since: planned.request.query.since,
      pageSize: planned.request.query.pageSize,
      page: planned.request.page,
    });
  }).pipe(
    Effect.provide(Layer.mergeAll(gh, RateLimit.layer)),
    Effect.provideService(GitHubCli.PinnedGitHubCredential, {
      host: account.host,
      credentialFingerprint: account.credentialFingerprint,
      token: Redacted.make("synthetic-token"),
    }),
  );
  const accepted = acceptPage({
    request: planned.request,
    currentFence: fence,
    response: page,
    observedAt: input.observedAt,
  });
  if (accepted.status !== "accepted" || accepted.snapshot.entries[0] === undefined)
    throw new Error("Synthetic page rejected");
  expect(accepted.snapshot.entries[0].title).toBe(title);
  return {
    ...input,
    repository: accepted.snapshot.repository,
    issue: accepted.snapshot.entries[0],
  };
});

describe("pure project issue intake", () => {
  it("captures an external observation without task creation or dispatch", () => {
    expect(mergeIssueObservation(input)).toEqual({
      status: "changed",
      record: {
        kind: "issue",
        recordId: "intake-a",
        projectId: input.projectId,
        revision: 0,
        generation: 0,
        updatedAt: input.observedAt,
        observedAt: input.observedAt,
        status: "open",
        identity: { host: "github.com", repositoryNodeId: "R_1", issueNodeId: "I_1", number: 1 },
        repositoryName: "owner/repo",
        title: "Issue",
        body: "Body",
        sourceRevision: issue.updatedAt,
      },
    });
  });
  it("deduplicates an unchanged repeated observation", () => {
    const existing = record();
    expect(mergeIssueObservation({ ...input, existing })).toEqual({
      status: "unchanged",
      record: existing,
    });
  });
  it.effect(
    "deduplicates the same padded title from the actual client through sync and intake",
    () =>
      Effect.gen(function* () {
        const observation = yield* clientObservation("  A padded title  ");
        const imported = mergeIssueObservation(observation);
        expect(imported).toMatchObject({ status: "changed", record: { title: "A padded title" } });
        if (imported.status !== "changed") throw new Error("Expected import");
        const existing = {
          ...imported.record,
          taskId: ProjectWorkTaskId.make("task-a"),
          missionId: "mission-a",
          revision: 3,
          generation: 4,
        };
        expect(mergeIssueObservation({ ...observation, existing })).toEqual({
          status: "unchanged",
          record: existing,
        });
      }),
  );
  it.effect(
    "accepts a same-source canonical rename for padded client titles without losing local history",
    () =>
      Effect.gen(function* () {
        const observation = yield* clientObservation("  A padded title  ");
        const imported = mergeIssueObservation(observation);
        if (imported.status !== "changed") throw new Error("Expected import");
        const existing = {
          ...imported.record,
          taskId: ProjectWorkTaskId.make("task-a"),
          missionId: "mission-a",
          revision: 3,
          generation: 4,
        };
        const renamed = yield* clientObservation("  A padded title  ", "renamed/repo");
        expect(mergeIssueObservation({ ...renamed, existing })).toEqual({
          status: "changed",
          record: { ...existing, repositoryName: "renamed/repo", revision: 4 },
        });
      }),
  );
  it("compares titles using the intake contract's whitespace normalization", () => {
    const existing = record();
    for (const title of [
      " \tIssue\n",
      "\u00a0Issue\u00a0",
      "\u2003Issue\u2003",
      "\ufeffIssue\ufeff",
    ]) {
      expect(mergeIssueObservation({ ...input, existing, issue: { ...issue, title } })).toEqual({
        status: "unchanged",
        record: existing,
      });
    }
    for (const title of ["", " \t\n", "\u00a0\u2003\ufeff"]) {
      expect(mergeIssueObservation({ ...input, issue: { ...issue, title } })).toEqual({
        status: "rejected",
        reason: "invalid-input",
      });
    }
  });
  it("retains genuine same-source title, body and state conflicts after title normalization", () => {
    const existing = record();
    for (const revised of [
      { ...issue, title: "  Different  " },
      { ...issue, title: "  Is sue  " },
      { ...issue, title: "  Issue  ", body: "Different" },
      { ...issue, title: "  Issue  ", state: "closed" },
    ])
      expect(mergeIssueObservation({ ...input, existing, issue: revised })).toEqual({
        status: "rejected",
        reason: "source-conflict",
      });
  });
  it("preserves local task, mission and generation through close and reopen", () => {
    const existing = {
      ...record(),
      generation: 8,
      taskId: ProjectWorkTaskId.make("task-a"),
      missionId: "mission-a",
    };
    const closed = mergeIssueObservation({
      ...input,
      existing,
      issue: {
        ...issue,
        state: "closed",
        closedAt: "2026-09-04T00:00:00Z",
        updatedAt: "2026-09-04T00:00:00Z",
      },
      observedAt: "2026-09-05T00:00:00Z",
    });
    expect(closed).toMatchObject({
      status: "changed",
      record: {
        status: "closed",
        taskId: existing.taskId,
        missionId: "mission-a",
        generation: 8,
        revision: 1,
      },
    });
    if (closed.status !== "changed") return;
    expect(
      mergeIssueObservation({
        ...input,
        existing: closed.record,
        issue: { ...issue, updatedAt: "2026-09-06T00:00:00Z" },
        observedAt: "2026-09-07T00:00:00Z",
      }),
    ).toMatchObject({
      status: "changed",
      record: {
        status: "open",
        revision: 2,
        taskId: existing.taskId,
        missionId: "mission-a",
        generation: 8,
      },
    });
  });
  it("ignores out-of-order source updates without overwriting local links or content", () => {
    const existing = {
      ...record(),
      taskId: ProjectWorkTaskId.make("task-a"),
      missionId: "mission-a",
    };
    expect(
      mergeIssueObservation({
        ...input,
        existing,
        issue: { ...issue, updatedAt: "2026-09-01T00:00:00Z", body: "Old", state: "closed" },
      }),
    ).toEqual({ status: "unchanged", record: existing });
  });
  it("flags same-revision content conflict without rewriting history", () => {
    expect(
      mergeIssueObservation({
        ...input,
        existing: record(),
        issue: { ...issue, body: "Conflicting" },
      }),
    ).toEqual({ status: "rejected", reason: "source-conflict" });
  });
  it("updates repository display name through rename without changing issue identity", () => {
    const existing = { ...record(), taskId: ProjectWorkTaskId.make("task-a") };
    expect(
      mergeIssueObservation({
        ...input,
        existing,
        repository: { ...repository, nameWithOwner: "renamed/repo" },
        issue: { ...issue, url: "https://github.com/renamed/repo/issues/1" },
      }),
    ).toMatchObject({
      status: "changed",
      record: {
        recordId: existing.recordId,
        identity: existing.identity,
        repositoryName: "renamed/repo",
        taskId: existing.taskId,
        revision: 1,
      },
    });
  });
  it("never reattaches detached history from a delayed observation", () => {
    const existing = { ...record(), status: "detached" as const };
    expect(
      mergeIssueObservation({
        ...input,
        existing,
        issue: { ...issue, updatedAt: "2026-09-04T00:00:00Z" },
      }),
    ).toEqual({ status: "rejected", reason: "detached" });
  });
  it("rejects attempts to retarget canonical identity or project record ownership", () => {
    for (const revised of [
      { ...input, projectId: ProjectId.make("project-b") },
      { ...input, recordId: "other-record" },
      { ...input, repository: { ...repository, nodeId: "R_2" } },
      { ...input, repository: { ...repository, host: "other.example.com" } },
      { ...input, issue: { ...issue, nodeId: "I_2" } },
      { ...input, issue: { ...issue, number: 2 } },
    ])
      expect(mergeIssueObservation({ ...revised, existing: record() })).toMatchObject({
        status: "rejected",
      });
  });
  it("rejects malformed external data and oversized bodies", () => {
    for (const invalid of [
      { ...input, issue: { ...issue, updatedAt: "invalid" } },
      { ...input, issue: { ...issue, title: "" } },
      { ...input, issue: { ...issue, body: "x".repeat(32_001) } },
      { ...input, observedAt: "2026-09-01T00:00:00Z" },
    ])
      expect(mergeIssueObservation(invalid)).toMatchObject({ status: "rejected" });
  });
  it("requires explicit project selection even for one connected project", () => {
    expect(selectIssueProject({ identity: record().identity, bindings: [record()] })).toEqual({
      status: "rejected",
      reason: "selection-required",
    });
  });
  it("selects the exact project from a shared repository without merging local history", () => {
    const a = { ...record(), taskId: ProjectWorkTaskId.make("task-a") };
    const b = {
      ...record(),
      projectId: ProjectId.make("project-b"),
      recordId: "intake-b",
      taskId: ProjectWorkTaskId.make("task-b"),
    };
    expect(
      selectIssueProject({ identity: a.identity, projectId: b.projectId, bindings: [a, b] }),
    ).toEqual({ status: "selected", record: b });
    expect(
      selectIssueProject({ identity: a.identity, projectId: a.projectId, bindings: [b, a] }),
    ).toEqual({ status: "selected", record: a });
  });
  it("rejects missing, detached, duplicate and foreign bindings", () => {
    const a = record();
    for (const bindings of [
      [],
      [{ ...a, status: "detached" }],
      [a, { ...a, recordId: "duplicate" }],
      [{ ...a, identity: { ...a.identity, repositoryNodeId: "R_2" } }],
    ]) {
      expect(
        selectIssueProject({ identity: a.identity, projectId: a.projectId, bindings }),
      ).toMatchObject({ status: "rejected" });
    }
  });
});
