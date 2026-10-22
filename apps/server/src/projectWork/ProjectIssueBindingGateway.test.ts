import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Binding from "./ProjectIssueBindingGateway.ts";
import {
  account,
  bindInput,
  issue,
  repository,
  seed,
  projectId,
  syncInput,
  testLayer,
} from "./ProjectIssue.test-utils.ts";
import * as Sync from "./ProjectIssueSyncWorker.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import { readIssueBinding } from "./ProjectIssueRepositoryState.ts";

it.effect("installation and binding are inert; repeated binding retains sync progress", () => {
  let reads = 0;
  return Effect.gen(function* () {
    yield* seed();
    const gateway = yield* Binding.ProjectIssueBindingGateway;
    const sql = yield* SqlClient.SqlClient;
    assert.equal(reads, 0);
    const first = yield* gateway.bind(bindInput, Effect.void);
    assert.equal(first.bindingRevision, 0);
    assert.equal(reads, 0);
    const rows = yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_work_events`;
    assert.equal(rows[0]?.count, 0);
    const retry = yield* gateway.bind(bindInput, Effect.void);
    assert.deepStrictEqual(retry, first);
    assert.equal((yield* gateway.list({ projectId }, Effect.void)).items.length, 1);
    yield* gateway.detach(syncInput, Effect.void);
    assert.equal((yield* gateway.list({ projectId }, Effect.void)).items[0]?.status, "detached");
    const stale = yield* Effect.result(gateway.bind(bindInput, Effect.void));
    assert.equal(stale._tag, "Failure");
    const rebound = yield* gateway.bind(
      { ...bindInput, expectedTargetBindingRevision: 1 },
      Effect.void,
    );
    assert.equal(rebound.bindingRevision, 2);
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          readIssuesPage: () =>
            Effect.sync(() => {
              reads++;
              return {
                status: "changed" as const,
                etag: null,
                repository: { host: "github.com", nodeId: "repo-1", nameWithOwner: "owner/repo" },
                entries: [],
                nextPage: null,
                rawEntryCount: 0,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("missing, deleted and mismatched projects fail before remote reads", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const gateway = yield* Binding.ProjectIssueBindingGateway;
    const sync = yield* Sync.ProjectIssueSyncWorker;
    assert.equal((yield* Effect.result(gateway.bind(bindInput, Effect.void)))._tag, "Failure");
    yield* seed();
    assert.equal(
      (yield* Effect.result(
        gateway.bind(
          {
            ...bindInput,
            expectedRepositoryKey: { ...bindInput.expectedRepositoryKey, host: "foreign.example" },
          },
          Effect.void,
        ),
      ))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.result(
        sync.readOnce({ ...syncInput, projectId: ProjectId.make("other") }, Effect.void),
      ))._tag,
      "Failure",
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at='1970-01-02T00:00:00.000Z' WHERE project_id=${projectId}`;
    assert.equal((yield* Effect.result(gateway.bind(bindInput, Effect.void)))._tag, "Failure");
    assert.equal(calls, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          getAccount: () =>
            Effect.sync(() => {
              calls++;
              return {
                host: "github.com",
                accountId: "1",
                viewer: "maintainer",
                credentialFingerprint: "pin",
              };
            }),
        },
      }),
    ),
  );
});

it.effect("revoked authorization rolls back binding and prevents remote access", () => {
  let calls = 0;
  return Effect.gen(function* () {
    yield* seed();
    const gateway = yield* Binding.ProjectIssueBindingGateway;
    const denied = Effect.fail(new Binding.IssueBindingGatewayError({ reason: "human-required" }));
    assert.equal((yield* Effect.result(gateway.bind(bindInput, denied)))._tag, "Failure");
    assert.equal(calls, 0);
    let checks = 0;
    const expires = Effect.suspend(() => (++checks === 1 ? Effect.void : denied));
    assert.equal((yield* Effect.result(gateway.bind(bindInput, expires)))._tag, "Failure");
    assert.deepStrictEqual((yield* gateway.list({ projectId }, Effect.void)).items, []);
  }).pipe(
    Effect.provide(
      testLayer({
        api: {
          getAccount: () =>
            Effect.sync(() => {
              calls++;
              return {
                host: "github.com",
                accountId: "12",
                viewer: "maintainer",
                credentialFingerprint: "pin-1",
              };
            }),
        },
      }),
    ),
  );
});

it.effect("a changed workspace root invalidates intake and binding refinements", () =>
  Effect.gen(function* () {
    yield* seed();
    const gateway = yield* Binding.ProjectIssueBindingGateway;
    const sync = yield* Sync.ProjectIssueSyncWorker;
    yield* gateway.bind(bindInput, Effect.void);
    yield* sync.readOnce(syncInput, Effect.void);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET workspace_root='/tmp/different-root' WHERE project_id=${projectId}`;
    assert.equal((yield* Effect.result(sync.readOnce(syncInput, Effect.void)))._tag, "Failure");
    assert.equal(
      (yield* Effect.result(
        gateway.assertRefinable({ projectId, issueRecordId: "missing" }, Effect.void),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "rebinding a renamed viewer resets sync authority and preserves same-account human work",
  () => {
    let currentAccount = { ...account };
    let reads = 0;
    const requests: Array<{ page?: number | undefined; etag?: string | undefined }> = [];
    return Effect.gen(function* () {
      yield* TestClock.adjust(600_000);
      yield* seed();
      const gateway = yield* Binding.ProjectIssueBindingGateway;
      const sync = yield* Sync.ProjectIssueSyncWorker;
      const work = yield* Repository.ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* gateway.bind(bindInput, Effect.void);
      yield* sync.readOnce(syncInput, Effect.void);
      const imported = yield* Repository.readCurrentState(sql, projectId);
      const intake = imported.foundationRecords?.find((record) => record.kind === "issue");
      if (intake === undefined) throw new Error("Expected issue intake");
      const taskId = ProjectWorkTaskId.make("renamed-viewer-task");
      const refinedAt = "1970-01-01T00:10:00.000Z";
      yield* work.execute({
        type: "project-work.issue.refine",
        commandId: CommandId.make("rename-refine"),
        projectId,
        expectedRevision: imported.revision,
        issueRecordId: intake.recordId,
        expectedIssueRevision: intake.revision,
        target: { kind: "new-task", taskId, title: "Human refinement", deliverableKind: "code" },
        refinedAt,
        attribution: {
          actor: { kind: "human", id: "maintainer" },
          source: { kind: "web", id: "session" },
          recordedAt: refinedAt,
        },
      });
      assert.equal((yield* sync.readOnce(syncInput, Effect.void)).status, "failure");
      const before = yield* readIssueBinding(sql, syncInput);
      assert.equal(before?.nextPage, 2);
      assert.equal(before?.highWater, "1970-01-01T00:10:00Z");
      assert.equal(before?.retryAt, 660_000);
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_issue_pages`)[0]?.count,
        1,
      );

      currentAccount = { ...account, viewer: "renamed-maintainer" };
      const renamedInput = {
        ...bindInput,
        accountLogin: currentAccount.viewer,
        expectedTargetBindingRevision: 0,
      };
      const rebound = yield* gateway.bind(renamedInput, Effect.void);
      assert.equal(rebound.bindingRevision, 1);
      const reset = yield* readIssueBinding(sql, syncInput);
      assert.equal(reset?.account.viewer, currentAccount.viewer);
      assert.equal(reset?.nextPage, 1);
      assert.equal(reset?.since, "1970-01-01T00:00:00Z");
      assert.equal(reset?.highWater, "1970-01-01T00:00:00Z");
      assert.equal(reset?.retryAt, null);
      assert.equal(reset?.syncRevision, 0);
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_issue_pages`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* gateway.list({ projectId }, Effect.void)).items[0]?.accountLogin,
        currentAccount.viewer,
      );
      const stale = yield* Effect.result(sync.readOnce(syncInput, Effect.void));
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") assert.equal(stale.failure.reason, "stale-binding");
      assert.equal(reads, 2);
      const freshInput = { ...syncInput, bindingRevision: 1 };
      assert.equal((yield* sync.readOnce(freshInput, Effect.void)).status, "committed");
      assert.equal(requests[2]?.page, 1);
      assert.equal(requests[2]?.etag, undefined);
      const updated = yield* Repository.readCurrentState(sql, projectId);
      const linked = updated.foundationRecords?.find((record) => record.kind === "issue");
      assert.equal(linked?.recordId, intake.recordId);
      if (linked?.kind === "issue") assert.equal(linked.taskId, taskId);
      assert.equal(updated.tasks[0]?.state, "draft");
      const unchanged = yield* readIssueBinding(sql, freshInput);
      assert.deepStrictEqual(
        yield* gateway.bind({ ...renamedInput, expectedTargetBindingRevision: 1 }, Effect.void),
        rebound,
      );
      assert.deepStrictEqual(yield* readIssueBinding(sql, freshInput), unchanged);
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            getAccount: () => Effect.sync(() => currentAccount),
            readIssuesPage: (input) =>
              Effect.suspend(() => {
                requests.push(input);
                reads++;
                if (input.account.viewer !== currentAccount.viewer)
                  return Effect.fail(
                    new GitHubIssueApi.GitHubIssueApiError({
                      reason: "account-mismatch",
                      host: account.host,
                    }),
                  );
                if (reads === 2)
                  return Effect.fail(
                    new GitHubIssueApi.GitHubIssueApiError({
                      reason: "rate-limited",
                      host: account.host,
                      retryAt: 660_000,
                    }),
                  );
                return Effect.succeed({
                  status: "changed" as const,
                  repository,
                  etag: '"rename-page"',
                  entries: [{ ...issue, updatedAt: "1970-01-01T00:10:00Z" }],
                  nextPage: reads === 1 ? 2 : null,
                  rawEntryCount: 1,
                });
              }),
          },
        }),
      ),
    );
  },
);

it.effect(
  "identity discovers only sanitized current repository and account metadata without binding",
  () => {
    const requests: Array<{ cwd: string; repository: string }> = [];
    return Effect.gen(function* () {
      yield* seed();
      const gateway = yield* Binding.ProjectIssueBindingGateway;
      assert.deepStrictEqual(yield* gateway.identity({ projectId }, Effect.void), {
        host: "github.com",
        repositoryNodeId: "repo-1",
        repositoryName: "owner/repo",
        accountLogin: "maintainer",
      });
      assert.deepStrictEqual(requests, [{ cwd: `/tmp/${projectId}`, repository: "owner/repo" }]);
      assert.deepStrictEqual((yield* gateway.list({ projectId }, Effect.void)).items, []);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_work_events`)[0]?.count,
        0,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            lookupRepository: (input) =>
              Effect.sync(() => {
                requests.push({ cwd: input.cwd, repository: input.repository });
                return {
                  status: "changed" as const,
                  etag: null,
                  data: {
                    ...repository,
                    url: "https://github.com/owner/repo",
                    updatedAt: "1970-01-01T00:00:00Z",
                  },
                };
              }),
          },
        }),
      ),
    );
  },
);

it.effect(
  "identity requires authorization before GitHub access and rechecks it after lookup",
  () => {
    let calls = 0;
    let checks = 0;
    const denied = Effect.fail(new Binding.IssueBindingGatewayError({ reason: "human-required" }));
    return Effect.gen(function* () {
      yield* seed();
      const gateway = yield* Binding.ProjectIssueBindingGateway;
      assert.equal(
        (yield* gateway.identity({ projectId }, denied).pipe(Effect.flip)).reason,
        "human-required",
      );
      assert.equal(calls, 0);
      const expires = Effect.suspend(() => (++checks === 1 ? Effect.void : denied));
      assert.equal(
        (yield* gateway.identity({ projectId }, expires).pipe(Effect.flip)).reason,
        "human-required",
      );
      assert.equal(checks, 2);
      assert.equal(calls, 2);
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            getAccount: () =>
              Effect.sync(() => {
                calls++;
                return account;
              }),
          },
        }),
      ),
    );
  },
);

it.effect("identity rejects a canonical repository changed during GitHub lookup", () => {
  let changed = false;
  return Effect.gen(function* () {
    yield* seed();
    const gateway = yield* Binding.ProjectIssueBindingGateway;
    assert.equal(
      (yield* gateway.identity({ projectId }, Effect.void).pipe(Effect.flip)).reason,
      "repository-mismatch",
    );
  }).pipe(
    Effect.provide(
      testLayer({
        resolve: () =>
          Effect.sync(() => ({
            canonicalKey: changed ? "github.com/other/repo" : "github.com/owner/repo",
            provider: "github" as const,
            displayName: changed ? "other/repo" : "owner/repo",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://github.com/owner/repo.git",
            },
          })),
        api: {
          lookupRepository: () =>
            Effect.sync(() => {
              changed = true;
              return {
                status: "changed" as const,
                etag: null,
                data: {
                  ...repository,
                  url: "https://github.com/owner/repo",
                  updatedAt: "1970-01-01T00:00:00Z",
                },
              };
            }),
        },
      }),
    ),
  );
});

it.effect(
  "identity rejects account routing changes and root changes before returning metadata",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* seed();
      const gateway = yield* Binding.ProjectIssueBindingGateway;
      assert.equal(
        (yield* gateway.identity({ projectId }, Effect.void).pipe(Effect.flip)).reason,
        "account-mismatch",
      );
      const sql = yield* SqlClient.SqlClient;
      let checks = 0;
      const moveRoot = Effect.suspend(() =>
        ++checks === 1
          ? Effect.void
          : sql`UPDATE projection_projects SET workspace_root='/tmp/changed' WHERE project_id=${projectId}`.pipe(
              Effect.asVoid,
              Effect.mapError(() => new Binding.IssueBindingGatewayError({ reason: "storage" })),
            ),
      );
      assert.equal(
        (yield* gateway.identity({ projectId }, moveRoot).pipe(Effect.flip)).reason,
        "repository-mismatch",
      );
    }).pipe(
      Effect.provide(
        testLayer({
          api: {
            getAccount: () =>
              Effect.sync(() => {
                calls++;
                return calls === 2 ? { ...account, credentialFingerprint: "changed-pin" } : account;
              }),
          },
        }),
      ),
    );
  },
);

it.effect.each([false, true])(
  "identity checks the canonical repository after the final account read (changed: %s)",
  (changeRemote) => {
    let accountReads = 0;
    let remoteChanged = false;
    return Effect.gen(function* () {
      yield* seed();
      const gateway = yield* Binding.ProjectIssueBindingGateway;
      const result = yield* Effect.result(gateway.identity({ projectId }, Effect.void));
      assert.equal(accountReads, 2);
      if (changeRemote) {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "repository-mismatch");
      } else {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success")
          assert.deepStrictEqual(result.success, {
            host: "github.com",
            repositoryNodeId: "repo-1",
            repositoryName: "owner/repo",
            accountLogin: "maintainer",
          });
      }
    }).pipe(
      Effect.provide(
        testLayer({
          resolve: () =>
            Effect.sync(() => ({
              provider: "github" as const,
              canonicalKey: remoteChanged ? "github.com/changed/repo" : "github.com/owner/repo",
              displayName: remoteChanged ? "changed/repo" : "owner/repo",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://github.com/owner/repo.git",
              },
            })),
          api: {
            getAccount: () =>
              Effect.sync(() => {
                accountReads++;
                if (accountReads === 2 && changeRemote) remoteChanged = true;
                return account;
              }),
          },
        }),
      ),
    );
  },
);
