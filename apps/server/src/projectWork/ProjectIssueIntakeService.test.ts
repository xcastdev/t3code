import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ProjectWorkApprovalId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
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
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { commitIssueRepositoryPage } from "./ProjectIssueIntakeService.ts";
import * as IssueWorker from "./ProjectIssueSyncWorker.ts";
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
import * as IssueClient from "./github/GitHubIssueClient.ts";
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

it.effect(
  "actual SQL intake preserves an approved task scope across newer, repeated, stale, and conflicting issue pages",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const linked = yield* seedLinked(f);
        const taskId = ProjectWorkTaskId.make("local-task");
        const criterionId = ProjectWorkCriterionId.make("local-criterion");
        const human = {
          actor: { kind: "human" as const, id: "maintainer" },
          source: { kind: "web" as const, id: "intake-regression" },
          recordedAt: at,
        };

        let state = yield* readCurrentState(f.sql, "a");
        yield* f.repo.execute({
          type: "project-work.criterion.upsert",
          projectId: ProjectId.make("a"),
          taskId,
          commandId: CommandId.make("approved-scope-criterion"),
          expectedRevision: state.revision,
          criterion: {
            criterionId,
            taskId,
            description: "Keep the reviewed behavior within the approved scope",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
          updatedAt: at,
        });
        state = yield* readCurrentState(f.sql, "a");
        yield* f.repo.execute({
          type: "project-work.task.specify",
          projectId: ProjectId.make("a"),
          taskId,
          commandId: CommandId.make("approved-scope-specification"),
          expectedRevision: state.revision,
          attribution: human,
          specification: {
            objective: "Investigate the linked issue without changing its approved scope",
            scopeIn: "Preserve the agreed behavior and its single acceptance criterion",
            scopeOut: "Unrelated product behavior and managed execution policy",
            criterionIds: [criterionId],
            revision: 1,
            protected: false,
          },
          updatedAt: at,
        });
        state = yield* readCurrentState(f.sql, "a");
        yield* f.repo.execute({
          type: "project-work.task.approve",
          projectId: ProjectId.make("a"),
          taskId,
          commandId: CommandId.make("approved-scope-approval"),
          expectedRevision: state.revision,
          attribution: human,
          approvalId: ProjectWorkApprovalId.make("approved-scope-approval"),
          specRevision: 1,
          approvedAt: at,
        });

        const approved = yield* readCurrentState(f.sql, "a");
        const taskBefore = approved.tasks.find((task) => task.taskId === taskId)!;
        const criteriaBefore = approved.criteria.filter((criterion) => criterion.taskId === taskId);
        expect(taskBefore).toMatchObject({
          taskId,
          state: "specified",
          specification: { revision: 1, criterionIds: [criterionId], protected: false },
          approval: {
            taskId,
            specRevision: 1,
            approvalId: ProjectWorkApprovalId.make("approved-scope-approval"),
          },
        });
        expect(criteriaBefore).toHaveLength(1);
        const historyBeforeNewer = yield* f.repo.replay("a");
        const taskHistoryBefore = historyBeforeNewer.filter(
          (event) =>
            ("taskId" in event && event.taskId === taskId) ||
            ("task" in event && event.task.taskId === taskId) ||
            ("criterion" in event && event.criterion.taskId === taskId),
        );

        const newer = {
          ...issue,
          title: "Updated external title",
          body: "Updated external description",
          bodyTruncated: false,
          updatedAt: "2026-10-01T00:20:00Z",
        };
        const accepted = yield* f.commit(yield* f.claim(), response([newer]));
        expect(accepted.accepted).toBe(true);
        expect(accepted.results).toHaveLength(1);
        expect(accepted.results[0]!.events).toHaveLength(1);

        const observed = (yield* issues(f.sql))[0]!;
        expect(observed).toMatchObject({
          recordId: linked.recordId,
          projectId: "a",
          revision: linked.revision + 1,
          sourceRevision: newer.updatedAt,
          title: newer.title,
          body: newer.body,
          taskId: linked.taskId,
          missionId: linked.missionId,
          identity: linked.identity,
        });
        const taskAfterNewer = (yield* readCurrentState(f.sql, "a")).tasks.find(
          (task) => task.taskId === taskId,
        )!;
        const criteriaAfterNewer = (yield* readCurrentState(f.sql, "a")).criteria.filter(
          (criterion) => criterion.taskId === taskId,
        );
        expect(taskAfterNewer).toEqual(taskBefore);
        expect((yield* readCurrentState(f.sql, "a")).tasks).toEqual(approved.tasks);
        expect(criteriaAfterNewer).toEqual(criteriaBefore);
        const historyAfterNewer = yield* f.repo.replay("a");
        expect(
          historyAfterNewer.filter(
            (event) =>
              ("taskId" in event && event.taskId === taskId) ||
              ("task" in event && event.task.taskId === taskId) ||
              ("criterion" in event && event.criterion.taskId === taskId),
          ),
        ).toEqual(taskHistoryBefore);
        const externalAfterNewer = yield* f.sql<{ payload: string }>`
          SELECT payload_json AS payload FROM project_issue_external
        `;
        expect(yield* decodeJson(externalAfterNewer[0]!.payload)).toEqual({
          repository,
          issue: newer,
        });
        const publicationsAfterNewer = [...f.published];

        for (const stale of [
          newer,
          {
            ...newer,
            title: "Older external title",
            body: "Older external description",
            updatedAt: "2026-10-01T00:15:00Z",
          },
        ]) {
          const replayed = yield* f.commit(yield* f.claim(), response([stale]));
          expect(replayed.accepted).toBe(true);
          expect(replayed.results).toEqual([]);
          expect((yield* issues(f.sql))[0]).toEqual(observed);
          expect(
            yield* f.sql<{ payload: string }>`
              SELECT payload_json AS payload FROM project_issue_external
            `,
          ).toEqual(externalAfterNewer);
          const current = yield* readCurrentState(f.sql, "a");
          expect(current.tasks).toEqual(approved.tasks);
          expect(current.criteria.filter((criterion) => criterion.taskId === taskId)).toEqual(
            criteriaBefore,
          );
          expect(yield* f.repo.replay("a")).toEqual(historyAfterNewer);
          expect(f.published).toEqual(publicationsAfterNewer);
        }

        // Rejected page transactions retain the original lease for the next observation.
        const leased = yield* f.claim();
        for (const conflicting of [
          { ...newer, body: "Conflicting body at the same source revision" },
          { ...newer, nodeId: "I_replaced", title: "Conflicting issue identity" },
        ]) {
          const before = yield* snapshot(f.sql);
          const historyBefore = yield* f.repo.replay("a");
          const publicationsBefore = [...f.published];
          expect((yield* f.commit(leased, response([conflicting])).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(yield* snapshot(f.sql)).toEqual(before);
          expect(yield* f.repo.replay("a")).toEqual(historyBefore);
          expect(f.published).toEqual(publicationsBefore);
          const current = yield* readCurrentState(f.sql, "a");
          expect(current.tasks).toEqual(approved.tasks);
          expect(current.criteria.filter((criterion) => criterion.taskId === taskId)).toEqual(
            criteriaBefore,
          );
        }
      }),
    ),
);

it.effect(
  "actual SQL intake preserves managed approved specification and plan records across issue pages",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const linked = yield* seedLinked(f);
        const taskId = ProjectWorkTaskId.make("local-task");
        const criterionId = ProjectWorkCriterionId.make("managed-intake-criterion");
        const human = {
          actor: { kind: "human" as const, id: "maintainer" },
          source: { kind: "web" as const, id: "intake-managed-regression" },
          recordedAt: now,
        };
        const envelope = Effect.fn("intakeTest.managedEnvelope")(function* (command: string) {
          const state = yield* readCurrentState(f.sql, "a");
          const task = state.tasks.find((entry) => entry.taskId === taskId);
          if (task === undefined) throw new Error("Missing linked task");
          return {
            projectId: ProjectId.make("a"),
            taskId,
            commandId: CommandId.make(command),
            expectedRevision: state.revision,
            expectedTaskRevision: task.revision,
          };
        });
        const guided = (intent: ProjectTeamGuidedIntent) =>
          f.repo.execute({
            type: "project-work.foundation.commit",
            projectId: ProjectId.make("a"),
            commandId: intent.commandId,
            expectedRevision: intent.expectedRevision,
            records: [],
            committedAt: now,
            attribution: human,
            guided: { intent },
          });
        const approveGates = Effect.fn("intakeTest.managedApproveGates")(function* () {
          const state = yield* readCurrentState(f.sql, "a");
          const gates =
            state.foundationRecords?.filter(
              (record): record is Extract<ProjectTeamRecord, { kind: "gate" }> =>
                record.kind === "gate" && record.status === "pending",
            ) ?? [];
          yield* f.repo.execute({
            type: "project-work.foundation.commit",
            projectId: ProjectId.make("a"),
            commandId: CommandId.make(`managed-intake-approve-${state.revision}`),
            expectedRevision: state.revision,
            records: gates.map((gate) => ({
              ...gate,
              status: "approved" as const,
              revision: gate.revision + 1,
            })),
            committedAt: now,
            attribution: human,
          });
        });
        yield* guided({
          ...(yield* envelope("managed-intake-spec")),
          type: "project-team.specification.propose",
          expectedSpecRevision: 0,
          specification: {
            objective: "Preserve the approved managed task scope during issue synchronization",
            scopeIn: "Retain the managed specification, plan, and criterion snapshots",
            scopeOut: "Changing managed execution policy or task scope",
            criterionIds: [criterionId],
            revision: 1,
            protected: false,
          },
          criterionSnapshots: [
            {
              criterionId,
              taskId,
              description: "Verify issue intake preserves the approved managed scope",
              required: true,
              status: "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: now,
            },
          ],
        });
        yield* approveGates();
        const planContent = "Preserve and verify the approved managed scope during intake";
        const stateBeforePlan = yield* readCurrentState(f.sql, "a");
        const taskBeforePlan = stateBeforePlan.tasks.find((task) => task.taskId === taskId);
        if (taskBeforePlan === undefined) throw new Error("Missing linked task");
        yield* guided({
          projectId: ProjectId.make("a"),
          taskId,
          commandId: CommandId.make("managed-intake-plan"),
          expectedRevision: stateBeforePlan.revision,
          expectedTaskRevision: taskBeforePlan.revision,
          type: "project-team.plan.propose",
          specRevision: 1,
          content: planContent,
          dependencyTaskIds: [],
        });
        yield* approveGates();

        const approved = yield* readCurrentState(f.sql, "a");
        const taskRecords =
          approved.foundationRecords?.filter(
            (record) => record.kind !== "issue" && "taskId" in record && record.taskId === taskId,
          ) ?? [];
        const criteria = approved.criteria.filter((criterion) => criterion.taskId === taskId);
        const tasks = approved.tasks;
        const history = (yield* f.repo.replay("a")).filter(
          (event) =>
            ("taskId" in event && event.taskId === taskId) ||
            ("task" in event && event.task.taskId === taskId) ||
            ("criterion" in event && event.criterion.taskId === taskId) ||
            ("record" in event &&
              event.record.kind !== "issue" &&
              "taskId" in event.record &&
              event.record.taskId === taskId),
        );
        expect(
          taskRecords.some(
            (record) => record.kind === "task-membership" && record.taskId === taskId,
          ),
        ).toBe(true);
        expect(
          taskRecords.some(
            (record) => record.kind === "plan-revision" && record.content === planContent,
          ),
        ).toBe(true);
        expect(
          taskRecords.filter((record) => record.kind === "gate" && record.status === "approved"),
        ).toHaveLength(2);
        expect(criteria).toHaveLength(1);
        const assertManagedScope = Effect.fn("intakeTest.assertManagedScope")(function* () {
          const current = yield* readCurrentState(f.sql, "a");
          expect(current.tasks).toEqual(tasks);
          expect(current.criteria.filter((criterion) => criterion.taskId === taskId)).toEqual(
            criteria,
          );
          expect(
            current.foundationRecords?.filter(
              (record) => record.kind !== "issue" && "taskId" in record && record.taskId === taskId,
            ) ?? [],
          ).toEqual(taskRecords);
          expect(
            (yield* f.repo.replay("a")).filter(
              (event) =>
                ("taskId" in event && event.taskId === taskId) ||
                ("task" in event && event.task.taskId === taskId) ||
                ("criterion" in event && event.criterion.taskId === taskId) ||
                ("record" in event &&
                  event.record.kind !== "issue" &&
                  "taskId" in event.record &&
                  event.record.taskId === taskId),
            ),
          ).toEqual(history);
        });
        const newer = {
          ...issue,
          title: "Managed task linked issue update",
          updatedAt: "2026-10-01T00:20:00Z",
        };
        const accepted = yield* f.commit(yield* f.claim(), response([newer]));
        expect(accepted.accepted).toBe(true);
        expect((yield* issues(f.sql))[0]).toMatchObject({
          recordId: linked.recordId,
          taskId,
          title: newer.title,
        });
        yield* assertManagedScope();
        for (const stale of [
          newer,
          { ...newer, title: "Older update", updatedAt: "2026-10-01T00:15:00Z" },
        ]) {
          const replayed = yield* f.commit(yield* f.claim(), response([stale]));
          expect(replayed.results).toEqual([]);
          yield* assertManagedScope();
        }
        const lease = yield* f.claim();
        for (const conflicting of [
          { ...newer, body: "Conflicting body at the same revision" },
          { ...newer, nodeId: "I_managed_replaced" },
        ]) {
          const before = yield* snapshot(f.sql);
          expect((yield* f.commit(lease, response([conflicting])).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(yield* snapshot(f.sql)).toEqual(before);
          yield* assertManagedScope();
        }
      }),
    ),
);

it.effect(
  "held issue reads apply the latest human-approved linked task scope and replay idempotently",
  () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          const linked = yield* seedLinked(f);
          const taskId = ProjectWorkTaskId.make("local-task");
          const criterionId = ProjectWorkCriterionId.make("held-read-criterion");
          const human = {
            actor: { kind: "human" as const, id: "maintainer" },
            source: { kind: "web" as const, id: "held-read-intake-regression" },
            recordedAt: now,
          };
          const envelope = Effect.fn("intakeTest.heldReadEnvelope")(function* (command: string) {
            const state = yield* readCurrentState(f.sql, "a");
            const task = state.tasks.find((entry) => entry.taskId === taskId);
            if (task === undefined) throw new Error("Missing linked task");
            return {
              projectId: ProjectId.make("a"),
              taskId,
              commandId: CommandId.make(command),
              expectedRevision: state.revision,
              expectedTaskRevision: task.revision,
            };
          });
          const guided = (intent: ProjectTeamGuidedIntent) =>
            f.repo.execute({
              type: "project-work.foundation.commit",
              projectId: ProjectId.make("a"),
              commandId: intent.commandId,
              expectedRevision: intent.expectedRevision,
              records: [],
              committedAt: now,
              attribution: human,
              guided: { intent },
            });
          const approveGates = Effect.fn("intakeTest.heldReadApproveGates")(function* () {
            const state = yield* readCurrentState(f.sql, "a");
            const pending =
              state.foundationRecords?.flatMap((record) =>
                record.kind === "gate" && record.taskId === taskId && record.status === "pending"
                  ? [record]
                  : [],
              ) ?? [];
            yield* f.repo.execute({
              type: "project-work.foundation.commit",
              projectId: ProjectId.make("a"),
              commandId: CommandId.make(`held-read-approve-${state.revision}`),
              expectedRevision: state.revision,
              records: pending.map((gate) => ({
                ...gate,
                status: "approved" as const,
                revision: gate.revision + 1,
              })),
              committedAt: now,
              attribution: human,
            });
          });
          const criterion = {
            criterionId,
            taskId,
            description: "Initially approved issue synchronization scope",
            required: true,
            status: "unsatisfied" as const,
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: now,
          };
          yield* guided({
            ...(yield* envelope("held-read-spec-1")),
            type: "project-team.specification.propose",
            expectedSpecRevision: 0,
            specification: {
              objective: "Retain the linked issue while synchronizing its approved task",
              scopeIn: "Preserve the current task scope and issue identity",
              scopeOut: "Changing task or repository ownership",
              criterionIds: [criterionId],
              revision: 1,
              protected: false,
            },
            criterionSnapshots: [criterion],
          });
          yield* approveGates();
          yield* guided({
            ...(yield* envelope("held-read-plan-1")),
            type: "project-team.plan.propose",
            specRevision: 1,
            content: "Preserve the linked task scope during issue synchronization",
            dependencyTaskIds: [],
          });
          yield* approveGates();

          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const leaseIds: Array<string> = [];
          const newer = {
            ...issue,
            title: "Remote issue read result",
            updatedAt: "2026-10-01T00:20:00Z",
          };
          const client = IssueClient.GitHubIssueClient.of({
            lookupRepository: () => Effect.die(new Error("unused repository lookup")),
            readIssuesPage: () =>
              Effect.gen(function* () {
                const state = yield* readIssueRepositoryState(f.sql, key).pipe(Effect.orDie);
                const leaseId = state?.lease?.id;
                if (leaseId === undefined)
                  throw new Error("Remote read started without an import lease");
                leaseIds.push(leaseId);
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
                return response([newer]);
              }),
            readCommentsPage: () => Effect.die(new Error("unused comment read")),
          });
          const makeWorker = () =>
            IssueWorker.make({
              resolveCredential: (state) =>
                Effect.succeed({
                  cwd: "/unused",
                  host: state.host,
                  accountNodeId: state.accountNodeId,
                  credentialEpoch: state.credentialEpoch,
                  token: Redacted.make("synthetic-token"),
                }),
            }).pipe(
              Effect.provideService(ProjectWorkRepository, f.repo),
              Effect.provideService(IssueClient.GitHubIssueClient, client),
            );
          const worker = yield* makeWorker();
          const pendingRead = yield* Effect.forkScoped(worker.readOnce(key));
          yield* Deferred.await(held);
          const leased = yield* readIssueRepositoryState(f.sql, key);
          const capturedLease = leased?.lease;
          if (capturedLease === undefined || capturedLease === null)
            throw new Error("Held read lost its import lease");
          expect(capturedLease.expiresAt).toBeGreaterThan(nowMillis);
          expect(leaseIds).toEqual([capturedLease.id]);

          yield* guided({
            ...(yield* envelope("held-read-spec-2")),
            type: "project-team.specification.propose",
            expectedSpecRevision: 1,
            specification: {
              objective: "Preserve the human-updated scope while applying a held issue read",
              scopeIn: "Retain the current issue identity, linked task, and revised criterion",
              scopeOut: "Changing task or repository ownership",
              criterionIds: [criterionId],
              revision: 2,
              protected: false,
            },
            criterionSnapshots: [
              { ...criterion, description: "Human-approved revised intake criterion" },
            ],
          });
          yield* approveGates();
          const beforePlan = yield* readCurrentState(f.sql, "a");
          const previousPlan = beforePlan.foundationRecords?.find(
            (record) =>
              record.kind === "plan-revision" &&
              record.taskId === taskId &&
              record.status === "proposed",
          );
          if (previousPlan?.kind !== "plan-revision")
            throw new Error("Missing current plan revision");
          yield* guided({
            ...(yield* envelope("held-read-plan-2")),
            type: "project-team.plan.propose",
            specRevision: 2,
            previousPlanId: previousPlan.recordId,
            expectedPreviousPlanRevision: previousPlan.revision,
            content: "Apply the fetched issue while preserving the revised approved task scope",
            dependencyTaskIds: [],
          });
          yield* approveGates();

          const approved = yield* readCurrentState(f.sql, "a");
          const tasks = approved.tasks;
          const criteria = approved.criteria.filter((entry) => entry.taskId === taskId);
          const taskRecords =
            approved.foundationRecords?.filter(
              (entry) => "taskId" in entry && entry.kind !== "issue" && entry.taskId === taskId,
            ) ?? [];
          const approvedTask = tasks.find((entry) => entry.taskId === taskId);
          if (approvedTask === undefined) throw new Error("Missing approved linked task");
          expect(approvedTask.specRevision).toBe(2);
          expect(criteria).toMatchObject([
            { criterionId, description: "Human-approved revised intake criterion", revision: 1 },
          ]);
          expect(
            taskRecords.some(
              (record) =>
                record.kind === "gate" &&
                record.gate === "specification" &&
                record.specRevision === 2 &&
                record.status === "approved",
            ),
          ).toBe(true);
          expect(
            taskRecords.some(
              (record) =>
                record.kind === "gate" &&
                record.gate === "plan" &&
                record.planRevision === 2 &&
                record.status === "approved",
            ),
          ).toBe(true);
          expect(
            taskRecords.some(
              (record) =>
                record.kind === "plan-revision" &&
                record.planRevision === 2 &&
                record.content ===
                  "Apply the fetched issue while preserving the revised approved task scope",
            ),
          ).toBe(true);
          const history = yield* f.repo.replay("a");
          const taskHistory = history.filter(
            (event) =>
              ("taskId" in event && event.taskId === taskId) ||
              ("task" in event && event.task.taskId === taskId) ||
              ("criterion" in event && event.criterion.taskId === taskId) ||
              ("record" in event &&
                event.record.kind !== "issue" &&
                "taskId" in event.record &&
                event.record.taskId === taskId),
          );
          const issueBefore = (yield* issues(f.sql)).find(
            (entry) => entry.recordId === linked.recordId,
          );
          if (issueBefore === undefined)
            throw new Error("Missing issue identity before page application");
          const assertApprovedScope = Effect.fn("intakeTest.assertHeldReadScope")(function* () {
            const current = yield* readCurrentState(f.sql, "a");
            expect(current.tasks).toEqual(tasks);
            expect(current.criteria.filter((entry) => entry.taskId === taskId)).toEqual(criteria);
            expect(
              current.foundationRecords?.filter(
                (entry) => "taskId" in entry && entry.kind !== "issue" && entry.taskId === taskId,
              ) ?? [],
            ).toEqual(taskRecords);
            expect(
              (yield* f.repo.replay("a")).filter(
                (event) =>
                  ("taskId" in event && event.taskId === taskId) ||
                  ("task" in event && event.task.taskId === taskId) ||
                  ("criterion" in event && event.criterion.taskId === taskId) ||
                  ("record" in event &&
                    event.record.kind !== "issue" &&
                    "taskId" in event.record &&
                    event.record.taskId === taskId),
              ),
            ).toEqual(taskHistory);
          });

          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(pendingRead)).status).toBe("committed");
          yield* assertApprovedScope();
          const issueAfter = (yield* issues(f.sql)).find(
            (entry) => entry.recordId === linked.recordId,
          );
          expect(issueAfter).toMatchObject({
            recordId: issueBefore.recordId,
            taskId,
            missionId: issueBefore.missionId,
            identity: issueBefore.identity,
            title: newer.title,
          });
          expect(yield* issues(f.sql)).toHaveLength(1);

          const firstReplay = yield* f.repo.replay("a");
          const afterFirstRead = yield* readIssueRepositoryState(f.sql, key);
          if (afterFirstRead === undefined)
            throw new Error("Missing repository state after page commit");
          yield* worker.stop;
          yield* TestClock.setTime(afterFirstRead.retryAt);
          const replayWorker = yield* makeWorker();
          expect((yield* replayWorker.readOnce(key)).status).toBe("committed");
          expect(leaseIds).toHaveLength(2);
          expect(new Set(leaseIds).size).toBe(2);
          expect(yield* f.repo.replay("a")).toEqual(firstReplay);
          yield* assertApprovedScope();
          expect(yield* issues(f.sql)).toHaveLength(1);
          const issueAfterReplay = (yield* issues(f.sql)).find(
            (entry) => entry.recordId === linked.recordId,
          );
          expect(issueAfterReplay).toMatchObject({
            recordId: issueBefore.recordId,
            taskId,
            missionId: issueBefore.missionId,
            identity: issueBefore.identity,
            title: newer.title,
          });
          yield* replayWorker.stop;
        }),
      ),
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
