import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectWorkTaskId,
  type ProjectWorkIssueRefineCommand,
} from "@t3tools/contracts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Binding from "./ProjectIssueBindingGateway.ts";
import * as Sync from "./ProjectIssueSyncWorker.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import {
  bindInput,
  seed,
  projectId,
  syncInput,
  testLayer,
  issue,
  repository,
} from "./ProjectIssue.test-utils.ts";

it.effect("one explicit page creates only intake proposals and durable conditional cache", () => {
  let reads = 0;
  const requests: Array<{ page?: number | undefined; etag?: string | undefined }> = [];
  return Effect.gen(function* () {
    yield* seed();
    const bindings = yield* Binding.ProjectIssueBindingGateway;
    const sync = yield* Sync.ProjectIssueSyncWorker;
    const work = yield* Repository.ProjectWorkRepository;
    yield* bindings.bind(bindInput, Effect.void);
    const first = yield* sync.readOnce(syncInput, Effect.void);
    assert.deepStrictEqual(first, { status: "committed", page: 1, nextPage: null, count: 1 });
    const events = yield* work.replay(projectId);
    assert.equal(events.length, 2);
    const issueEvent = events.find(
      (event) => event.type === "project-work.foundation.recorded" && event.record.kind === "issue",
    );
    assert.equal(issueEvent?.type, "project-work.foundation.recorded");
    if (issueEvent?.type !== "project-work.foundation.recorded") return;
    assert.equal(issueEvent.record.kind, "issue");
    yield* bindings.assertRefinable(
      { projectId, issueRecordId: issueEvent.record.recordId },
      Effect.void,
    );
    const second = yield* sync.readOnce(syncInput, Effect.void);
    assert.equal(second.status, "committed");
    assert.equal(reads, 2);
    assert.deepStrictEqual(
      requests.map((request) => request.etag),
      [undefined, '"one"'],
    );
    const state = yield* Repository.readCurrentState(yield* SqlClient.SqlClient, projectId);
    assert.deepStrictEqual(state.tasks, []);
    assert.deepStrictEqual(state.attempts, []);
    assert.equal(state.foundationRecords?.filter((record) => record.kind === "issue").length, 1);
    assert.equal(state.foundationRecords?.find((record) => record.kind === "issue")?.revision, 0);
    assert.equal(
      state.foundationRecords?.some(
        (record) =>
          record.kind === "gate" || record.kind === "run-binding" || record.kind === "effect",
      ),
      false,
    );
    yield* bindings.bind(bindInput, Effect.void);
    yield* bindings.detach(syncInput, Effect.void);
    assert.equal(
      (yield* Effect.result(
        bindings.assertRefinable(
          { projectId, issueRecordId: issueEvent.record.recordId },
          Effect.void,
        ),
      ))._tag,
      "Failure",
    );
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          readIssuesPage: (input) =>
            Effect.sync(() => {
              requests.push(input);
              reads++;
              return reads === 1
                ? {
                    status: "changed" as const,
                    etag: '"one"',
                    repository,
                    entries: [issue],
                    nextPage: null,
                    rawEntryCount: 1,
                  }
                : { status: "not-modified" as const, etag: '"one"', repository };
            }),
        },
      }),
    ),
  );
});

it.effect("pagination resumes its durable cursor and never follows another page implicitly", () => {
  const pages: Array<number | undefined> = [];
  return Effect.gen(function* () {
    yield* seed();
    const bindings = yield* Binding.ProjectIssueBindingGateway;
    const sync = yield* Sync.ProjectIssueSyncWorker;
    yield* bindings.bind(bindInput, Effect.void);
    assert.deepStrictEqual(yield* sync.readOnce(syncInput, Effect.void), {
      status: "committed",
      page: 1,
      nextPage: 2,
      count: 1,
    });
    assert.deepStrictEqual(pages, [1]);
    yield* bindings.bind(bindInput, Effect.void);
    assert.deepStrictEqual(yield* sync.readOnce(syncInput, Effect.void), {
      status: "committed",
      page: 2,
      nextPage: null,
      count: 1,
    });
    assert.deepStrictEqual(pages, [1, 2]);
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          readIssuesPage: (input) =>
            Effect.sync(() => {
              pages.push(input.page);
              return {
                status: "changed" as const,
                repository,
                etag: null,
                entries: [{ ...issue, nodeId: `issue-${input.page}`, number: input.page ?? 1 }],
                nextPage: input.page === 1 ? 2 : null,
                rawEntryCount: 1,
              };
            }),
        },
      }),
    ),
  );
});

it.effect(
  "completed sweeps advance the overlap window and conditionally reuse its exact query",
  () => {
    const requests: Array<{ since: string; etag?: string | undefined }> = [];
    return Effect.gen(function* () {
      yield* TestClock.adjust(600_000);
      yield* seed();
      yield* (yield* Binding.ProjectIssueBindingGateway).bind(bindInput, Effect.void);
      const sync = yield* Sync.ProjectIssueSyncWorker;
      yield* sync.readOnce(syncInput, Effect.void);
      yield* sync.readOnce(syncInput, Effect.void);
      yield* sync.readOnce(syncInput, Effect.void);
      assert.deepStrictEqual(
        requests.map(({ since, etag }) => ({ since, etag })),
        [
          { since: "1970-01-01T00:00:00Z", etag: undefined },
          { since: "1970-01-01T00:09:00Z", etag: undefined },
          { since: "1970-01-01T00:09:00Z", etag: '"recent"' },
        ],
      );
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            readIssuesPage: (input) =>
              Effect.sync(() => {
                requests.push(input);
                return input.etag === undefined
                  ? {
                      status: "changed" as const,
                      repository,
                      etag: '"recent"',
                      entries: [{ ...issue, updatedAt: "1970-01-01T00:10:00Z" }],
                      nextPage: null,
                      rawEntryCount: 1,
                    }
                  : { status: "not-modified" as const, repository, etag: '"recent"' };
              }),
          },
        }),
      ),
    );
  },
);

it.effect("rate pauses survive requests and resume only after their persisted deadline", () => {
  let reads = 0;
  return Effect.gen(function* () {
    yield* seed();
    const bindings = yield* Binding.ProjectIssueBindingGateway;
    const sync = yield* Sync.ProjectIssueSyncWorker;
    yield* bindings.bind(bindInput, Effect.void);
    const first = yield* sync.readOnce(syncInput, Effect.void);
    assert.deepStrictEqual(first, { status: "failure", reason: "rate-limited", retryAt: 60_000 });
    assert.deepStrictEqual(yield* sync.readOnce(syncInput, Effect.void), {
      status: "paused",
      retryAt: 60_000,
    });
    assert.equal(reads, 1);
    yield* TestClock.adjust(60_000);
    assert.equal((yield* sync.readOnce(syncInput, Effect.void)).status, "committed");
    assert.equal(reads, 2);
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          readIssuesPage: () =>
            Effect.suspend(() => {
              reads++;
              return reads === 1
                ? Effect.fail(
                    new GitHubIssueApi.GitHubIssueApiError({
                      reason: "rate-limited",
                      host: "github.com",
                      retryAt: 60_000,
                    }),
                  )
                : Effect.succeed({
                    status: "changed" as const,
                    repository,
                    etag: null,
                    entries: [],
                    nextPage: null,
                    rawEntryCount: 0,
                  });
            }),
        },
      }),
    ),
  );
});

it.effect(
  "revocation after the remote read rolls back cache, cursor, and Work records together",
  () => {
    let checks = 0;
    return Effect.gen(function* () {
      yield* seed();
      const bindings = yield* Binding.ProjectIssueBindingGateway;
      const sync = yield* Sync.ProjectIssueSyncWorker;
      yield* bindings.bind(bindInput, Effect.void);
      const authorize = Effect.suspend(() =>
        ++checks === 1
          ? Effect.void
          : Effect.fail(new Binding.IssueBindingGatewayError({ reason: "human-required" })),
      );
      assert.equal((yield* Effect.result(sync.readOnce(syncInput, authorize)))._tag, "Failure");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_issue_pages`)[0]?.count,
        0,
      );
      assert.deepStrictEqual(
        yield* (yield* Repository.ProjectWorkRepository).replay(projectId),
        [],
      );
      assert.equal((yield* sync.readOnce(syncInput, Effect.void)).status, "committed");
    }).pipe(Effect.provide(testLayer()));
  },
);

it.effect("a detached binding fences an in-flight page without cache or Work writes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* seed();
      const bindings = yield* Binding.ProjectIssueBindingGateway;
      const sync = yield* Sync.ProjectIssueSyncWorker;
      yield* bindings.bind(bindInput, Effect.void);
      const read = yield* sync
        .readOnce(syncInput, Effect.void)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      yield* bindings.detach(syncInput, Effect.void);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(read))._tag, "Failure");
      assert.deepStrictEqual(
        yield* (yield* Repository.ProjectWorkRepository).replay(projectId),
        [],
      );
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            readIssuesPage: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  status: "changed" as const,
                  repository,
                  etag: null,
                  entries: [issue],
                  nextPage: null,
                  rawEntryCount: 1,
                };
              }),
          },
        }),
      ),
    );
  }),
);

it.effect("a not-modified response requires cache for the exact bound query", () => {
  let reads = 0;
  return Effect.gen(function* () {
    yield* seed();
    yield* (yield* Binding.ProjectIssueBindingGateway).bind(bindInput, Effect.void);
    const sync = yield* Sync.ProjectIssueSyncWorker;
    yield* sync.readOnce(syncInput, Effect.void);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE t3_workflow_v2_issue_pages SET request_hash='different-account-root-query'`;
    assert.equal((yield* Effect.result(sync.readOnce(syncInput, Effect.void)))._tag, "Failure");
    assert.equal((yield* (yield* Repository.ProjectWorkRepository).replay(projectId)).length, 2);
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          readIssuesPage: () =>
            Effect.sync(() => {
              reads++;
              return reads === 1
                ? {
                    status: "changed" as const,
                    repository,
                    etag: '"one"',
                    entries: [issue],
                    nextPage: null,
                    rawEntryCount: 1,
                  }
                : { status: "not-modified" as const, repository, etag: '"one"' };
            }),
        },
      }),
    ),
  );
});

it.effect("foreign repository pages and skipped cursors never enter intake", () =>
  Effect.gen(function* () {
    for (const response of [
      {
        status: "changed" as const,
        repository: { ...repository, nodeId: "foreign" },
        etag: null,
        entries: [issue],
        nextPage: null,
        rawEntryCount: 1,
      },
      {
        status: "changed" as const,
        repository,
        etag: null,
        entries: [issue],
        nextPage: 3,
        rawEntryCount: 1,
      },
    ]) {
      yield* Effect.gen(function* () {
        yield* seed();
        yield* (yield* Binding.ProjectIssueBindingGateway).bind(bindInput, Effect.void);
        assert.equal(
          (yield* Effect.result(
            (yield* Sync.ProjectIssueSyncWorker).readOnce(syncInput, Effect.void),
          ))._tag,
          "Failure",
        );
        assert.deepStrictEqual(
          yield* (yield* Repository.ProjectWorkRepository).replay(projectId),
          [],
        );
      }).pipe(
        Effect.provide(testLayer({ api: { readIssuesPage: () => Effect.succeed(response) } })),
      );
    }
  }),
);

it.effect(
  "refinement checks the task revision and later sync preserves its inert human link",
  () => {
    let reads = 0;
    return Effect.gen(function* () {
      yield* seed();
      yield* (yield* Binding.ProjectIssueBindingGateway).bind(bindInput, Effect.void);
      const sync = yield* Sync.ProjectIssueSyncWorker;
      yield* sync.readOnce(syncInput, Effect.void);
      const work = yield* Repository.ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const origin = {
        actor: { kind: "human" as const, id: "maintainer" },
        source: { kind: "web" as const, id: "session" },
        recordedAt: "1970-01-01T00:00:00.000Z",
      };
      const taskId = ProjectWorkTaskId.make("existing-task");
      yield* work.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("create-task"),
        projectId,
        taskId,
        title: "Human draft",
        createdAt: origin.recordedAt,
        attribution: origin,
      });
      const state = yield* Repository.readCurrentState(sql, projectId);
      const intake = state.foundationRecords?.find((record) => record.kind === "issue");
      if (intake === undefined) throw new Error("Expected imported issue");
      const refine: ProjectWorkIssueRefineCommand = {
        type: "project-work.issue.refine",
        commandId: CommandId.make("refine"),
        projectId,
        expectedRevision: state.revision,
        attribution: origin,
        issueRecordId: intake.recordId,
        expectedIssueRevision: intake.revision,
        target: { kind: "existing-task", taskId, expectedTaskRevision: 1 },
        refinedAt: origin.recordedAt,
      };
      assert.equal((yield* Effect.result(work.execute(refine)))._tag, "Failure");
      yield* work.execute({
        ...refine,
        target: { kind: "existing-task", taskId, expectedTaskRevision: 0 },
      });
      yield* TestClock.adjust(60_000);
      yield* sync.readOnce(syncInput, Effect.void);
      const updated = yield* Repository.readCurrentState(sql, projectId);
      const linked = updated.foundationRecords?.find((record) => record.kind === "issue");
      assert.equal(linked?.kind, "issue");
      if (linked?.kind === "issue") {
        assert.equal(linked.taskId, taskId);
        assert.equal(linked.revision, 2);
        assert.equal(linked.title, "Later issue edit");
      }
      assert.equal(updated.tasks[0]?.state, "draft");
      assert.equal(updated.tasks[0]?.approval, undefined);
      assert.deepStrictEqual(updated.attempts, []);
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            readIssuesPage: () =>
              Effect.sync(() => {
                reads++;
                return {
                  status: "changed" as const,
                  repository,
                  etag: null,
                  entries: [
                    reads === 1
                      ? issue
                      : { ...issue, title: "Later issue edit", updatedAt: "1970-01-01T00:01:00Z" },
                  ],
                  nextPage: null,
                  rawEntryCount: 1,
                };
              }),
          },
        }),
      ),
    );
  },
);
