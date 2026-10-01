import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectIssueIntake,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { commitIssueRepositoryPage } from "./ProjectIssueIntakeService.ts";
import {
  bindIssueRepositoryProject,
  claimIssueRepositoryRead,
  readIssueRepositoryState,
  rotateIssueRepositoryCredential,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { retireProjectIssueRepositories } from "./ProjectIssueRepositoryLifecycle.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import {
  ProjectWorkEventBus,
  ProjectWorkEventBusLive,
  type ProjectWorkCommittedEvent,
} from "./ProjectWorkEventBus.ts";
import { PROJECT_TEAM_TABLES } from "./ProjectTeamsPersistence.ts";
import { writeCommittedIssuePage } from "./github/GitHubIssuePageStore.ts";
import type { IssuePageSnapshot, IssueSyncRequest } from "./github/GitHubIssueSync.ts";

const decodeIntake = Schema.decodeUnknownEffect(ProjectIssueIntake);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const at = "2026-10-01T00:00:00Z";
const now = "2026-10-01T01:00:00Z";
const nowMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(now));
const repository = {
  host: "github.com",
  nodeId: "R_repository",
  nameWithOwner: "owner/repository",
};
const key = { host: repository.host, repositoryNodeId: repository.nodeId };
const issue: IssuePageSnapshot["entries"][number] = {
  nodeId: "I_issue",
  number: 1,
  title: "Retained issue",
  titleTruncated: true,
  body: "Original description",
  bodyTruncated: true,
  state: "open" as const,
  updatedAt: "2026-10-01T00:10:00Z",
  closedAt: null,
  url: "https://github.com/owner/repository/issues/1",
  commentCount: 4,
};
const response = (
  entries = [issue],
  nextPage: number | null = null,
  name = repository.nameWithOwner,
) => ({
  status: "changed" as const,
  repository: { ...repository, nameWithOwner: name },
  etag: '"page"',
  entries,
  nextPage,
  rawEntryCount: entries.length,
});
const request = (state: IssueRepositoryState): IssueSyncRequest => ({
  repository: { ...repository, nameWithOwner: state.repositoryName },
  account: {
    host: state.host,
    nodeId: state.accountNodeId,
    credentialFingerprint: state.credentialEpoch,
  },
  query: { since: state.since, pageSize: 25, state: "all", sort: "updated", direction: "asc" },
  page: state.nextPage,
  generation: state.authorityGeneration,
  leaseId: state.lease!.id,
});
const setup = Effect.fn("intakeTest.setup")(function* (suppliedSql?: SqlClient.SqlClient) {
  yield* TestClock.setTime(nowMillis);
  yield* runMigrations();
  const sql = suppliedSql ?? (yield* SqlClient.SqlClient);
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},'Test','/unused','[]',${at},${at})`;
  const bus = yield* ProjectWorkEventBus;
  const published: Array<ProjectWorkCommittedEvent> = [];
  const repo = yield* ProjectWorkRepository.pipe(
    Effect.provide(Layer.fresh(ProjectWorkRepositoryLive)),
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provideService(ProjectWorkEventBus, {
      ...bus,
      publish: (events) =>
        Effect.sync(() => {
          published.push(...events);
        }).pipe(Effect.andThen(bus.publish(events))),
    }),
  );
  let claimNumber = 0;
  const bind = (projectId = "a", expectedBindingRevision: number | null = null) =>
    bindIssueRepositoryProject(sql, {
      key,
      projectId,
      expectedBindingRevision,
      repositoryName: repository.nameWithOwner,
      accountNodeId: "U_account",
      credentialEpoch: "epoch",
      since: at,
    });
  const claim = Effect.fn("intakeTest.claim")(function* () {
    const state = yield* claimIssueRepositoryRead(sql, key, {
      leaseId: `lease-${++claimNumber}`,
      durationMs: 1000,
      sweepStartedAt: now,
    });
    expect(state?.lease).toBeDefined();
    return state!;
  });
  const commit = (state: IssueRepositoryState, incoming: unknown = response(), sentEtag?: string) =>
    commitIssueRepositoryPage(sql, {
      request: request(state),
      lease: state.lease!,
      response: incoming,
      ...(sentEtag === undefined ? {} : { sentEtag }),
    }).pipe(
      Effect.provideService(ProjectWorkRepository, repo),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  return { sql, repo, bus, published, bind, claim, commit };
});
type Fixture = Effect.Success<ReturnType<typeof setup>>;
const memory = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(ProjectWorkEventBusLive, NodeSqliteClient.layerMemory())),
  );
const snapshot = Effect.fn("intakeTest.snapshot")(function* (sql: SqlClient.SqlClient) {
  const data: Record<string, ReadonlyArray<unknown>> = {};
  for (const name of [
    "project_issue_repository",
    "project_issue_binding",
    "project_issue_page",
    "project_issue_external",
    "project_work_events",
    "project_work_command_receipts",
    "project_work_reducer_checkpoints",
    "project_work_attention",
    "project_work_attention_occurrences",
    "project_work_notification_publications",
    "project_work_tasks",
    "project_work_attempts",
    ...PROJECT_TEAM_TABLES,
    "sqlite_sequence",
  ])
    data[name] = yield* sql`SELECT * FROM ${sql(name)}`;
  return data;
});
const issues = Effect.fn("intakeTest.issues")(function* (sql: SqlClient.SqlClient, project = "a") {
  return (
    (yield* readCurrentState(sql, project)).foundationRecords?.filter(
      (record) => record.kind === "issue",
    ) ?? []
  );
});
const seedLinked = Effect.fn("intakeTest.seedLinked")(function* (
  f: Fixture,
  status: "open" | "detached" = "open",
) {
  yield* f.repo.execute({
    type: "project-work.task.create",
    projectId: ProjectId.make("a"),
    taskId: ProjectWorkTaskId.make("local-task"),
    commandId: CommandId.make("local-task"),
    title: "Local investigation",
    createdAt: at,
  });
  const state = yield* readCurrentState(f.sql, "a");
  const old = yield* decodeIntake({
    kind: "issue",
    recordId: "retained-custom-id",
    projectId: "a",
    revision: 0,
    generation: 7,
    updatedAt: at,
    observedAt: at,
    sourceRevision: at,
    status,
    identity: {
      host: repository.host,
      repositoryNodeId: repository.nodeId,
      issueNodeId: issue.nodeId,
      number: issue.number,
    },
    repositoryName: repository.nameWithOwner,
    title: "Before sync",
    body: "Local external copy",
    taskId: "local-task",
    missionId: "local-mission",
  });
  yield* f.repo.execute({
    type: "project-work.foundation.commit",
    projectId: ProjectId.make("a"),
    commandId: CommandId.make("local-link"),
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "system", id: "fixture" },
      source: { kind: "import", id: "fixture" },
      recordedAt: at,
    },
    records: [old],
    committedAt: at,
  });
  f.published.length = 0;
  return old;
});

it.effect(
  "commits one shared external page and one attributed project command per binding, with no dispatch",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        yield* f.bind("b");
        const stream = yield* f.bus.subscribe;
        const received = yield* Stream.runCollect(stream.pipe(Stream.take(2))).pipe(
          Effect.forkScoped,
        );
        const leased = yield* f.claim();
        const result = yield* f.commit(leased);
        expect(result.accepted).toBe(true);
        expect(result.page?.commitId).toBe("1");
        expect(result.results).toHaveLength(2);
        expect(yield* Fiber.join(received)).toHaveLength(2);
        expect(f.published.map((event) => event.cursor)).toEqual([1, 2]);
        expect(yield* f.sql`SELECT * FROM project_issue_external`).toHaveLength(1);
        expect(yield* f.sql`SELECT * FROM project_issue_page`).toHaveLength(1);
        const external = yield* f.sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM project_issue_external`;
        expect(yield* decodeJson(external[0]!.payload)).toEqual({ repository, issue });
        for (const id of ["a", "b"]) expect(yield* issues(f.sql, id)).toHaveLength(1);
        expect(
          yield* f.sql`SELECT actor_kind AS actorKind,actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId FROM project_work_command_receipts`,
        ).toEqual(
          [1, 2].map(() => ({
            actorKind: "system",
            actorId: "github-intake",
            sourceKind: "import",
            sourceId: "github-intake",
          })),
        );
        for (const name of [
          "project_work_tasks",
          "project_work_attempts",
          "project_team_run_binding",
          "project_team_effect",
          "project_team_gate",
          "project_team_task_membership",
        ])
          expect(yield* f.sql`SELECT * FROM ${f.sql(name)}`).toEqual([]);
        const before = yield* snapshot(f.sql);
        expect((yield* f.commit(leased)).accepted).toBe(false);
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toHaveLength(2);
      }),
    ),
);

it.effect(
  "continues multi-page and PR-only pages with a fixed window, then overlaps the fixed sweep by five minutes",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        yield* f.commit(yield* f.claim(), response([issue], 2));
        expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
          since: at,
          nextPage: 2,
          sweepStartedAt: now,
        });
        yield* TestClock.setTime(nowMillis + 500);
        yield* f.commit(yield* f.claim(), { ...response([], 3), rawEntryCount: 25 });
        expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
          since: at,
          nextPage: 3,
          sweepStartedAt: now,
        });
        const second = {
          ...issue,
          nodeId: "I_second",
          number: 2,
          url: "https://github.com/owner/repository/issues/2",
          updatedAt: "2026-10-01T00:50:00Z",
        };
        yield* f.commit(yield* f.claim(), response([second]));
        expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
          since: "2026-10-01T00:55:00Z",
          nextPage: 1,
          sweepStartedAt: null,
          lastSuccessfulPageAt: now,
        });
        expect(yield* issues(f.sql)).toHaveLength(2);
        expect(f.published).toHaveLength(2);
      }),
    ),
);

it.effect(
  "repeated and out-of-order observations preserve linked local history and newer external metadata",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const old = yield* seedLinked(f);
        yield* f.commit(yield* f.claim());
        const retained = (yield* issues(f.sql))[0]!;
        expect(retained).toMatchObject({
          recordId: old.recordId,
          taskId: old.taskId,
          missionId: old.missionId,
          generation: 7,
          revision: 1,
        });
        const before = yield* issues(f.sql);
        const external = yield* f.sql`SELECT * FROM project_issue_external`;
        for (const incoming of [
          response(),
          response([
            { ...issue, title: "Old title", body: "Old body", updatedAt: at, commentCount: 0 },
          ]),
        ]) {
          const result = yield* f.commit(yield* f.claim(), incoming);
          expect(result.results).toEqual([]);
          expect(yield* issues(f.sql)).toEqual(before);
          expect(yield* f.sql`SELECT * FROM project_issue_external`).toEqual(external);
        }
        expect(f.published).toHaveLength(1);
      }),
    ),
);

it.effect("same-node rename and close/reopen keep the custom record and task/mission links", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.bind();
      const old = yield* seedLinked(f);
      yield* f.commit(yield* f.claim());
      const renamed = { ...issue, url: "https://github.com/new-owner/new-repository/issues/1" };
      yield* f.commit(yield* f.claim(), response([renamed], null, "new-owner/new-repository"));
      expect((yield* issues(f.sql))[0]).toMatchObject({
        recordId: old.recordId,
        repositoryName: "new-owner/new-repository",
        taskId: old.taskId,
        missionId: old.missionId,
        generation: 7,
      });
      expect((yield* readIssueRepositoryState(f.sql, key))?.repositoryName).toBe(
        repository.nameWithOwner,
      );
      const stored = yield* f.sql<{
        payload: string;
      }>`SELECT payload_json AS payload FROM project_issue_external`;
      expect(yield* decodeJson(stored[0]!.payload)).toEqual({
        repository: { ...repository, nameWithOwner: "new-owner/new-repository" },
        issue: renamed,
      });
      for (const [status, updatedAt] of [
        ["closed", "2026-10-01T00:20:00Z"],
        ["open", "2026-10-01T00:30:00Z"],
      ] as const) {
        yield* f.commit(
          yield* f.claim(),
          response(
            [
              {
                ...renamed,
                state: status,
                updatedAt,
                closedAt: status === "closed" ? updatedAt : null,
              },
            ],
            null,
            "new-owner/new-repository",
          ),
        );
        expect((yield* issues(f.sql))[0]).toMatchObject({
          recordId: old.recordId,
          status,
          taskId: old.taskId,
          missionId: old.missionId,
          generation: 7,
        });
      }
      expect(yield* f.sql`SELECT * FROM project_team_gate`).toEqual([]);
    }),
  ),
);

for (const [cachedEtag, responseEtag] of [
  ['W/"page"', '"page"'],
  ['"page"', 'W/"page"'],
  ['W/"page"', 'W/"page"'],
  ['"page"', '"page"'],
  ['W/""', '""'],
] as const) {
  it.effect(
    `native intake preserves committed ETag ${cachedEtag} through 200 then 304 ${responseEtag}`,
    () =>
      memory(
        Effect.gen(function* () {
          const f = yield* setup();
          // Keep the next sweep's five-minute overlap identical to the first read key.
          yield* bindIssueRepositoryProject(f.sql, {
            key,
            projectId: "a",
            expectedBindingRevision: null,
            repositoryName: repository.nameWithOwner,
            accountNodeId: "U_account",
            credentialEpoch: "epoch",
            since: "2026-10-01T00:55:00Z",
          });
          const initial = yield* f.commit(yield* f.claim(), { ...response(), etag: cachedEtag });
          expect(initial.accepted).toBe(true);
          expect(initial.page?.etag).toBe(cachedEtag);
          const imported = yield* issues(f.sql);
          const publications = [...f.published];
          const conditional = yield* f.commit(
            yield* f.claim(),
            { status: "not-modified", repository, etag: responseEtag },
            cachedEtag,
          );
          expect(conditional.accepted).toBe(true);
          expect(conditional.page?.etag).toBe(cachedEtag);
          expect(conditional.page?.entries).toEqual(initial.page?.entries);
          expect(yield* issues(f.sql)).toEqual(imported);
          expect(f.published).toEqual(publications);
          expect(yield* f.sql`SELECT * FROM project_work_tasks`).toEqual([]);
          expect(yield* f.sql`SELECT * FROM project_work_attempts`).toEqual([]);
        }),
      ),
  );
}

for (const kind of [
  "valid",
  "missing-snapshot",
  "missing-sent-etag",
  "wrong-sent-etag",
  "equivalent-wrong-sent-etag",
  "wrong-response-etag",
  "forged-commit-id",
] as const)
  it.effect(`304 acceptance uses actual committed SQL and actual sent ETag: ${kind}`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const leased = yield* f.claim();
        const req = request(leased);
        if (kind !== "missing-snapshot") {
          const page: IssuePageSnapshot = {
            ...response(),
            repository,
            account: req.account,
            query: req.query,
            page: req.page,
            generation: req.generation,
          };
          yield* f.sql.withTransaction(writeCommittedIssuePage(f.sql, req, page));
        }
        const before = yield* snapshot(f.sql);
        const incoming = {
          status: "not-modified",
          repository,
          etag: kind === "wrong-response-etag" ? 'W/"other"' : 'W/"page"',
          ...(kind === "forged-commit-id" ? { commitId: "1" } : {}),
        };
        const outcome = yield* f
          .commit(
            leased,
            incoming,
            kind === "missing-sent-etag"
              ? undefined
              : kind === "wrong-sent-etag"
                ? '"wrong"'
                : kind === "equivalent-wrong-sent-etag"
                  ? 'W/"page"'
                  : '"page"',
          )
          .pipe(Effect.result);
        expect(outcome._tag).toBe(kind === "valid" ? "Success" : "Failure");
        if (kind === "valid") {
          expect(yield* issues(f.sql)).toHaveLength(1);
          expect(f.published).toHaveLength(1);
        } else {
          expect(yield* snapshot(f.sql)).toEqual(before);
          expect(f.published).toEqual([]);
        }
      }),
    ),
  );

for (const target of [
  "project_issue_page",
  "project_issue_external",
  "project_team_issue",
  "project_work_command_receipts",
] as const)
  it.effect(
    `late SQL failure in ${target} rolls back all state/events/sequences, then exact retry commits once`,
    () =>
      memory(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          yield* f.bind("b");
          const leased = yield* f.claim();
          const before = yield* snapshot(f.sql);
          const guard =
            target === "project_work_command_receipts" || target === "project_team_issue"
              ? "NEW.project_id='b'"
              : "1";
          yield* f.sql`CREATE TRIGGER refuse_page BEFORE INSERT ON ${f.sql(target)} WHEN ${f.sql.literal(guard)} BEGIN SELECT RAISE(ABORT,'refused'); END`;
          expect((yield* f.commit(leased).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* snapshot(f.sql)).toEqual(before);
          expect(f.published).toEqual([]);
          yield* f.sql`DROP TRIGGER refuse_page`;
          expect((yield* f.commit(leased)).page?.commitId).toBe("1");
          expect(f.published.map((event) => event.cursor)).toEqual([1, 2]);
          expect((yield* f.commit(leased)).accepted).toBe(false);
          expect(f.published).toHaveLength(2);
        }),
      ),
  );

for (const changed of [
  "page",
  "since",
  "page-size",
  "sort",
  "account",
  "epoch",
  "generation",
  "lease-id",
  "repository-name",
  "extra-authority",
] as const)
  it.effect(`forged current request ${changed} cannot write any table`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const leased = yield* f.claim();
        const req = request(leased);
        const forged = {
          ...req,
          ...(changed === "page" ? { page: 2 } : {}),
          ...(changed === "generation" ? { generation: req.generation + 1 } : {}),
          ...(changed === "lease-id" ? { leaseId: "forged" } : {}),
          ...(changed === "repository-name"
            ? { repository: { ...req.repository, nameWithOwner: "wrong/repository" } }
            : {}),
          ...(changed === "account" ? { account: { ...req.account, nodeId: "U_wrong" } } : {}),
          ...(changed === "epoch"
            ? { account: { ...req.account, credentialFingerprint: "forged" } }
            : {}),
          ...(changed === "since"
            ? { query: { ...req.query, since: "2026-09-30T00:00:00Z" } }
            : {}),
          ...(changed === "page-size" ? { query: { ...req.query, pageSize: 100 } } : {}),
        };
        if (changed === "sort") Object.assign(forged.query, { direction: "desc" });
        const before = yield* snapshot(f.sql);
        const outcome = yield* commitIssueRepositoryPage(f.sql, {
          request: forged,
          lease: leased.lease!,
          response: response(),
          ...(changed === "extra-authority"
            ? { projectIds: ["b"], observedAt: at, commandId: "caller" }
            : {}),
        }).pipe(Effect.provideService(ProjectWorkRepository, f.repo), Effect.result);
        expect(outcome._tag).toBe("Failure");
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toEqual([]);
      }),
    ),
  );

it.effect("fan-out caps at eight actual bindings and page size at 25", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup();
      for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) yield* f.bind(id);
      expect((yield* f.bind("i").pipe(Effect.result))._tag).toBe("Failure");
      const leased = yield* f.claim();
      const many = Array.from({ length: 25 }, (_, n) => ({
        ...issue,
        nodeId: `I_${n}`,
        number: n + 1,
        url: `https://github.com/owner/repository/issues/${n + 1}`,
      }));
      const before = yield* snapshot(f.sql);
      expect(
        (yield* f
          .commit(leased, {
            ...response([...many, { ...issue, nodeId: "overflow", number: 26 }]),
            rawEntryCount: 26,
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* snapshot(f.sql)).toEqual(before);
      const result = yield* f.commit(leased, response(many));
      expect(result.results).toHaveLength(8);
      expect(result.results.every((entry) => entry.events.length === 25)).toBe(true);
      expect(yield* f.sql`SELECT * FROM project_issue_external`).toHaveLength(25);
      expect(f.published).toHaveLength(200);
    }),
  ),
);

for (const mode of [
  "detached",
  "duplicate-identity",
  "record-id-collision",
  "source-conflict",
] as const)
  it.effect(`refuses local ${mode} conflicts without losing local history`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        if (mode === "detached") yield* seedLinked(f, "detached");
        else if (mode === "record-id-collision") {
          const id = `github-issue-${NodeCrypto.createHash("sha256")
            .update(
              canonicalProjectWorkPayload(["a", repository.host, repository.nodeId, issue.nodeId]),
            )
            .digest("hex")}`;
          const state = yield* readCurrentState(f.sql, "a");
          const record = yield* decodeIntake({
            kind: "issue",
            recordId: id,
            projectId: "a",
            revision: 0,
            generation: 0,
            updatedAt: at,
            observedAt: at,
            sourceRevision: at,
            status: "open",
            identity: {
              host: "github.com",
              repositoryNodeId: "R_foreign",
              issueNodeId: "I_foreign",
              number: 1,
            },
            repositoryName: "other/repository",
            title: "Foreign",
            body: "",
          });
          yield* f.repo.execute({
            type: "project-work.foundation.commit",
            projectId: ProjectId.make("a"),
            commandId: CommandId.make("collision"),
            expectedRevision: state.revision,
            records: [record],
            attribution: { actor: { kind: "system" }, source: { kind: "import" }, recordedAt: at },
            committedAt: at,
          });
        } else {
          yield* f.commit(yield* f.claim());
          if (mode === "duplicate-identity") {
            const state = yield* readCurrentState(f.sql, "a");
            const original = (yield* issues(f.sql))[0]!;
            const payload = yield* encodeJson({
              ...state,
              foundationRecords: [
                ...state.foundationRecords!,
                { ...original, recordId: "duplicate-identity", revision: 0 },
              ],
            });
            yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${payload} WHERE project_id='a'`;
          }
        }
        const leased = yield* f.claim();
        f.published.length = 0;
        const before = yield* snapshot(f.sql);
        expect(
          (yield* f
            .commit(
              leased,
              mode === "source-conflict"
                ? response([{ ...issue, title: "Conflicting title" }])
                : response(),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toEqual([]);
      }),
    ),
  );

for (const field of [
  "host",
  "repository",
  "node",
  "number",
  "revision",
  "malformed",
  "oversized",
] as const)
  it.effect(`refuses corrupt shared external physical/payload ${field}`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        yield* f.commit(yield* f.claim());
        const payload =
          field === "malformed"
            ? "{"
            : field === "oversized"
              ? " ".repeat(256 * 1024 + 1)
              : yield* encodeJson({
                  repository: {
                    ...repository,
                    ...(field === "host" ? { host: "wrong.example" } : {}),
                    ...(field === "repository" ? { nodeId: "R_wrong" } : {}),
                  },
                  issue: {
                    ...issue,
                    ...(field === "node" ? { nodeId: "I_wrong" } : {}),
                    ...(field === "number" ? { number: 2 } : {}),
                    ...(field === "revision" ? { updatedAt: at } : {}),
                  },
                });
        yield* f.sql`UPDATE project_issue_external SET payload_json=${payload}`;
        const leased = yield* f.claim();
        f.published.length = 0;
        const before = yield* snapshot(f.sql);
        expect((yield* f.commit(leased).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toEqual([]);
      }),
    ),
  );

for (const change of ["replacement", "rotation", "archive", "detach"] as const)
  it.effect(`authority ${change} before callback admits no cache/external/project write`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const leased = yield* f.claim();
        if (change === "replacement") {
          yield* TestClock.setTime(leased.lease!.expiresAt);
          yield* f.claim();
        }
        if (change === "rotation")
          yield* rotateIssueRepositoryCredential(f.sql, key, {
            accountNodeId: "U_account",
            credentialEpoch: "new-epoch",
            expectedRevision: leased.revision,
          });
        if (change === "archive")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/unused',1,${at})`;
        if (change === "detach")
          yield* f.sql.withTransaction(retireProjectIssueRepositories(f.sql, "a", false));
        const before = yield* snapshot(f.sql);
        expect((yield* f.commit(leased)).accepted).toBe(false);
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toEqual([]);
      }),
    ),
  );

it.effect(
  "complete reducer authority includes checkpoint tail rather than a bounded intake projection",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        yield* seedLinked(f);
        const checkpoints = yield* f.sql`SELECT * FROM project_work_reducer_checkpoints`;
        yield* f.commit(yield* f.claim());
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints`;
        for (const row of checkpoints)
          yield* f.sql`INSERT INTO project_work_reducer_checkpoints ${f.sql.insert(row)}`;
        const newer = {
          ...issue,
          title: "Read past old checkpoint",
          updatedAt: "2026-10-01T00:20:00Z",
        };
        yield* f.commit(yield* f.claim(), response([newer]));
        expect((yield* issues(f.sql))[0]).toMatchObject({
          recordId: "retained-custom-id",
          revision: 2,
          title: newer.title,
          taskId: "local-task",
          generation: 7,
        });
      }),
    ),
);

it.effect(
  "actual file-backed restart resumes the committed next page and keeps project links",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "intake.sqlite");
      yield* Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        yield* seedLinked(f);
        yield* f.commit(yield* f.claim(), response([issue], 2));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeSqliteClient.layer({ filename }), ProjectWorkEventBusLive),
        ),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* ProjectWorkRepository;
        const state = (yield* claimIssueRepositoryRead(sql, key, {
          leaseId: "restart-lease",
          durationMs: 1000,
          sweepStartedAt: "2026-10-01T01:30:00Z",
        }))!;
        expect(state.nextPage).toBe(2);
        expect(state.sweepStartedAt).toBe(now);
        const second = { ...issue, updatedAt: "2026-10-01T00:20:00Z", title: "After restart" };
        const result = yield* commitIssueRepositoryPage(sql, {
          request: request(state),
          lease: state.lease!,
          response: response([second]),
        }).pipe(Effect.provideService(ProjectWorkRepository, repo));
        expect(result.accepted).toBe(true);
        expect(result.page?.commitId).toBe("2");
        expect((yield* issues(sql))[0]).toMatchObject({
          recordId: "retained-custom-id",
          taskId: "local-task",
          missionId: "local-mission",
          generation: 7,
          revision: 2,
        });
        expect(yield* readIssueRepositoryState(sql, key)).toMatchObject({
          nextPage: 1,
          since: "2026-10-01T00:55:00Z",
          sweepStartedAt: null,
        });
      }).pipe(
        Effect.provide(
          ProjectWorkRepositoryLive.pipe(
            Layer.provideMerge(
              Layer.mergeAll(ProjectWorkEventBusLive, NodeSqliteClient.layer({ filename })),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const stage of ["cache", "external", "receipt"] as const)
  it.effect(
    `server-clock expiry during held actual ${stage} SQL receipt rolls back without publication`,
    () =>
      memory(
        Effect.gen(function* () {
          const nativeSql = yield* SqlClient.SqlClient;
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let intercept = false;
          const table =
            stage === "cache"
              ? "project_issue_page"
              : stage === "external"
                ? "project_issue_external"
                : "project_work_command_receipts";
          const sql = new Proxy(nativeSql, {
            apply(target, _receiver, args) {
              const statement = target(args[0], ...args.slice(1));
              if (
                intercept &&
                Array.isArray(args[0]) &&
                "raw" in args[0] &&
                statement.compile()[0].includes(`INSERT INTO ${table}`)
              ) {
                intercept = false;
                return statement.pipe(
                  Effect.tap(() =>
                    Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
                  ),
                );
              }
              return statement;
            },
          });
          const f = yield* setup(sql);
          yield* f.bind();
          const leased = yield* f.claim();
          const before = yield* snapshot(sql);
          intercept = true;
          const pending = yield* f.commit(leased).pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(held);
          expect(f.published).toEqual([]);
          yield* TestClock.setTime(leased.lease!.expiresAt);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(pending))._tag).toBe("Failure");
          expect(yield* snapshot(sql)).toEqual(before);
          expect(f.published).toEqual([]);
        }),
      ),
  );

for (const stage of ["cache", "receipt"] as const)
  for (const change of ["replacement", "rotation", "archive", "detach"] as const)
    it.effect(
      `authority ${change} after held actual ${stage} receipt rolls back the whole page`,
      () =>
        memory(
          Effect.gen(function* () {
            const nativeSql = yield* SqlClient.SqlClient;
            const held = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let intercept = false;
            const table =
              stage === "cache" ? "project_issue_page" : "project_work_command_receipts";
            const sql = new Proxy(nativeSql, {
              apply(target, _receiver, args) {
                const statement = target(args[0], ...args.slice(1));
                if (
                  intercept &&
                  Array.isArray(args[0]) &&
                  "raw" in args[0] &&
                  statement.compile()[0].includes(`INSERT INTO ${table}`)
                ) {
                  intercept = false;
                  return statement.pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        yield* Deferred.succeed(held, undefined);
                        yield* Deferred.await(release);
                        if (change === "archive")
                          yield* nativeSql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/unused',1,${now})`;
                        if (change === "detach")
                          yield* retireProjectIssueRepositories(sql, "a", false);
                        if (change === "rotation") {
                          const current = (yield* readIssueRepositoryState(sql, key))!;
                          yield* rotateIssueRepositoryCredential(sql, key, {
                            accountNodeId: current.accountNodeId,
                            credentialEpoch: "rotated-after-receipt",
                            expectedRevision: current.revision,
                          });
                        }
                        if (change === "replacement") {
                          const current = (yield* readIssueRepositoryState(sql, key))!;
                          const payload = yield* encodeJson({
                            ...current,
                            lease:
                              current.lease === null
                                ? null
                                : { ...current.lease, id: "replacement-after-receipt" },
                          });
                          yield* nativeSql`UPDATE project_issue_repository SET payload_json=${payload} WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
                        }
                      }),
                    ),
                  );
                }
                return statement;
              },
            });
            const f = yield* setup(sql);
            yield* f.bind();
            yield* f.bind("b");
            const leased = yield* f.claim();
            const before = yield* snapshot(sql);
            intercept = true;
            const pending = yield* f.commit(leased).pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(held);
            expect(f.published).toEqual([]);
            yield* Deferred.succeed(release, undefined);
            expect((yield* Fiber.join(pending))._tag).toBe("Failure");
            expect(yield* snapshot(sql)).toEqual(before);
            expect(f.published).toEqual([]);
            expect(yield* sql`SELECT * FROM project_lifecycle`).toEqual([]);
          }),
        ),
    );

for (const change of [
  "binding-project",
  "binding-revision",
  "binding-generation",
  "expiry",
  "epoch",
] as const)
  it.effect(`forged supplied lease ${change} does not enter page writes`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const leased = yield* f.claim();
        const lease = leased.lease!;
        const forged = {
          ...lease,
          ...(change === "expiry" ? { expiresAt: lease.expiresAt + 1 } : {}),
          ...(change === "epoch" ? { credentialEpoch: "forged" } : {}),
          bindings: lease.bindings.map((binding) => ({
            ...binding,
            ...(change === "binding-project" ? { projectId: "b" } : {}),
            ...(change === "binding-revision" ? { revision: binding.revision + 1 } : {}),
            ...(change === "binding-generation" ? { generation: binding.generation + 1 } : {}),
          })),
        };
        const before = yield* snapshot(f.sql);
        const result = yield* commitIssueRepositoryPage(f.sql, {
          request: request(leased),
          lease: forged,
          response: response(),
        }).pipe(Effect.provideService(ProjectWorkRepository, f.repo));
        expect(result.accepted).toBe(false);
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toEqual([]);
      }),
    ),
  );

it.effect(
  "a corrupted project source at an identical revision rejects even when the shared external copy is valid",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        yield* f.commit(yield* f.claim());
        const state = yield* readCurrentState(f.sql, "a");
        const payload = yield* encodeJson({
          ...state,
          foundationRecords: state.foundationRecords!.map((record) =>
            record.kind === "issue" ? { ...record, body: "Conflicting local source" } : record,
          ),
        });
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${payload} WHERE project_id='a'`;
        const leased = yield* f.claim();
        f.published.length = 0;
        const before = yield* snapshot(f.sql);
        expect((yield* f.commit(leased).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* snapshot(f.sql)).toEqual(before);
        expect(f.published).toEqual([]);
      }),
    ),
);

it.effect("persists terminal sweep delay with page progress and fences reads until it is due", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.bind();
      const claimed = yield* f.claim();
      const result = yield* commitIssueRepositoryPage(f.sql, {
        request: request(claimed),
        lease: claimed.lease!,
        response: response(),
        nextSweepDelayMs: 60_000,
      }).pipe(Effect.provideService(ProjectWorkRepository, f.repo));
      expect(result.accepted).toBe(true);
      const durable = yield* readIssueRepositoryState(f.sql, key);
      expect(durable?.retryAt).toBe(nowMillis + 60_000);
      expect(durable?.nextPage).toBe(1);
      expect(durable?.sweepStartedAt).toBeNull();
      const early = yield* claimIssueRepositoryRead(f.sql, key, {
        leaseId: "early",
        durationMs: 1_000,
        sweepStartedAt: now,
      });
      expect(early).toBeUndefined();
      yield* TestClock.adjust("60 seconds");
      const due = yield* claimIssueRepositoryRead(f.sql, key, {
        leaseId: "due",
        durationMs: 1_000,
        sweepStartedAt: "2026-10-01T01:01:00Z",
      });
      expect(due?.lease?.id).toBe("due");
      expect(due?.since).toBe("2026-10-01T00:55:00Z");
    }),
  ),
);

it.effect("continues a nonterminal page immediately despite a requested terminal delay", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.bind();
      const claimed = yield* f.claim();
      const result = yield* commitIssueRepositoryPage(f.sql, {
        request: request(claimed),
        lease: claimed.lease!,
        response: response([issue], 2),
        nextSweepDelayMs: 60_000,
      }).pipe(Effect.provideService(ProjectWorkRepository, f.repo));
      expect(result.accepted).toBe(true);
      const durable = yield* readIssueRepositoryState(f.sql, key);
      expect(durable?.retryAt).toBe(0);
      expect(durable?.nextPage).toBe(2);
      const due = yield* f.claim();
      expect(due.nextPage).toBe(2);
    }),
  ),
);
