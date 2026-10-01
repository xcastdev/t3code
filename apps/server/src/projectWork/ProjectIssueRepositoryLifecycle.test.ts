import { CommandId, ProjectId, ProjectIssueRepositoryCursor } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectLifecycle, ProjectLifecycleLive } from "../project/ProjectLifecycle.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { retireProjectIssueRepositories } from "./ProjectIssueRepositoryLifecycle.ts";
import {
  bindIssueRepositoryProject,
  claimIssueRepositoryRead,
  commitIssueRepositoryRead,
  readIssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";

const key = { host: "github.com", repositoryNodeId: "R_repository" };
const at = "2026-10-01T00:00:00Z";
const layer = Layer.mergeAll(ProjectLifecycleLive, ProjectWorkRepositoryLive).pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(FileSystem.layerNoop({})),
);
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(100);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["a", "b"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},'Test','/workspace','[]',${at},${at})`;
  return sql;
});
const bind = (
  sql: SqlClient.SqlClient,
  projectId: string,
  expectedBindingRevision: number | null = null,
) =>
  bindIssueRepositoryProject(sql, {
    key,
    projectId,
    expectedBindingRevision,
    accountNodeId: "U_account",
    repositoryName: "owner/repository",
    credentialEpoch: "epoch-1",
    since: at,
  });
const claim = (sql: SqlClient.SqlClient, leaseId = "old-read") =>
  claimIssueRepositoryRead(sql, key, { leaseId, durationMs: 1000, sweepStartedAt: at });
const deletion = (projectId: string) => ({
  projectId: ProjectId.make(projectId),
  commandId: CommandId.make("delete-" + projectId),
  workspaceRoot: "/workspace",
  confirmation: "permanent-local-delete" as const,
});
const cursor = Schema.decodeUnknownSync(ProjectIssueRepositoryCursor)({
  kind: "intake-cursor",
  recordId: "old-cursor",
  projectId: "a",
  status: "ready",
  revision: 0,
  generation: 0,
  updatedAt: at,
  host: key.host,
  repositoryNodeId: key.repositoryNodeId,
  accountId: "U_account",
  cursor: "old-page",
  etag: "old-etag",
  overlapSince: at,
});
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(ProjectIssueRepositoryCursor));
const history = Effect.fn("repositoryLifecycleHistory")(function* (sql: SqlClient.SqlClient) {
  const repo = yield* ProjectWorkRepository;
  yield* repo.execute({
    type: "project-work.foundation.commit",
    projectId: ProjectId.make("a"),
    commandId: CommandId.make("old-cursor-create"),
    expectedRevision: 0,
    attribution: {
      actor: { kind: "system", id: "test" },
      source: { kind: "system", id: "test" },
      recordedAt: at,
    },
    committedAt: at,
    records: [cursor],
  });
  yield* sql`INSERT INTO project_issue_repository_legacy(record_id,project_id,host,repository_node_id,payload_json,import_status) VALUES('old-cursor','a',${key.host},${key.repositoryNodeId},${encodeCursor(cursor)},'imported')`;
  yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'page-key','issues','{}')`;
  yield* sql`INSERT INTO project_issue_external(host,repository_node_id,issue_node_id,issue_number,source_revision,payload_json) VALUES(${key.host},${key.repositoryNodeId},'I_issue',1,${at},'{}')`;
});

it.effect("retirement cannot mutate bindings outside the lifecycle SQL transaction", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* bind(sql, "a");
    const before = yield* readIssueRepositoryState(sql, key);
    const bindings = yield* sql`SELECT * FROM project_issue_binding`;
    expect(yield* retireProjectIssueRepositories(sql, "a", true).pipe(Effect.result)).toMatchObject(
      {
        _tag: "Failure",
        failure: { _tag: "IssueRepositoryStateError", reason: "invalid-input" },
      },
    );
    expect(yield* readIssueRepositoryState(sql, key)).toEqual(before);
    expect(yield* sql`SELECT * FROM project_issue_binding`).toEqual(bindings);
  }).pipe(Effect.provide(layer)),
);

it.effect("retained detached owners do not exhaust the active-binding limit", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    const lifecycle = yield* ProjectLifecycle;
    for (let index = 0; index < 10; index++) {
      const projectId = "archived-" + index;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Archived','/workspace','[]',${at},${at})`;
      yield* bind(sql, projectId);
      yield* lifecycle.archive({
        projectId: ProjectId.make(projectId),
        commandId: CommandId.make("archive-" + index),
      });
    }
    expect(yield* sql`SELECT * FROM project_issue_binding WHERE status='detached'`).toHaveLength(
      10,
    );
    expect((yield* readIssueRepositoryState(sql, key))?.status).toBe("detached");
    yield* bind(sql, "a");
    expect((yield* claim(sql))?.lease?.bindings.map((entry) => entry.projectId)).toEqual(["a"]);
    yield* lifecycle.permanentDelete(deletion("a"));
    expect(yield* sql`SELECT * FROM project_issue_binding`).toHaveLength(10);
    expect((yield* readIssueRepositoryState(sql, key))?.status).toBe("detached");
  }).pipe(Effect.provide(layer)),
);

it.effect("archive and deletion retire every repository across the bounded keyset page", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    const lifecycle = yield* ProjectLifecycle;
    for (let index = 0; index < 129; index++)
      yield* bindIssueRepositoryProject(sql, {
        key: { host: "github.com", repositoryNodeId: "R_" + String(index).padStart(3, "0") },
        projectId: "a",
        accountNodeId: "U_account",
        repositoryName: "owner/repository",
        credentialEpoch: "epoch-1",
        since: at,
        expectedBindingRevision: null,
      });
    yield* lifecycle.archive({
      projectId: ProjectId.make("a"),
      commandId: CommandId.make("archive-129"),
    });
    expect(
      yield* sql`SELECT * FROM project_issue_binding WHERE status='detached' AND revision=1 AND generation=1`,
    ).toHaveLength(129);
    expect(
      yield* sql`SELECT * FROM project_issue_repository WHERE json_extract(payload_json,'$.status')='detached' AND json_extract(payload_json,'$.authorityGeneration')=1`,
    ).toHaveLength(129);
    yield* lifecycle.permanentDelete(deletion("a"));
    expect(yield* sql`SELECT * FROM project_issue_repository`).toHaveLength(0);
    expect(yield* sql`SELECT * FROM project_issue_binding`).toHaveLength(0);
  }).pipe(Effect.provide(layer)),
);

it.effect("archive fences the old shared read and restore requires an explicit rebind", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* bind(sql, "a");
    yield* bind(sql, "b");
    const old = (yield* claim(sql))!;
    const lifecycle = yield* ProjectLifecycle;
    yield* lifecycle.archive({
      projectId: ProjectId.make("a"),
      commandId: CommandId.make("archive-a"),
    });
    expect(
      (yield* sql`SELECT status,revision,generation FROM project_issue_binding WHERE project_id='a'`)[0],
    ).toEqual({ status: "detached", revision: 1, generation: 1 });
    const after = (yield* readIssueRepositoryState(sql, key))!;
    expect(after.lease).toBeNull();
    expect(after.authorityGeneration).toBe(old.authorityGeneration + 1);
    expect(after.since).toBe(old.since);
    let prepared = false;
    const delayed = yield* commitIssueRepositoryRead(sql, key, old.lease!, () =>
      Effect.sync(() => {
        prepared = true;
        return {
          commands: [],
          progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
        };
      }),
    );
    expect(delayed.accepted).toBe(false);
    expect(prepared).toBe(false);
    expect((yield* claim(sql, "b-read"))?.lease?.bindings.map((entry) => entry.projectId)).toEqual([
      "b",
    ]);
    yield* lifecycle.restore({
      projectId: ProjectId.make("a"),
      commandId: CommandId.make("restore-a"),
    });
    expect(
      (yield* sql`SELECT status FROM project_issue_binding WHERE project_id='a'`)[0]?.status,
    ).toBe("detached");
    yield* bind(sql, "a", 1);
    expect((yield* claim(sql, "rebound"))?.lease?.bindings.map((entry) => entry.projectId)).toEqual(
      ["a", "b"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "deleting the last explicit owner removes its history and never infers another owner from issue identity",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql, "a");
      yield* history(sql);
      yield* sql`INSERT INTO project_team_issue(record_id,project_id,status,revision,generation,updated_at,payload_json) VALUES('b-issue','b','open',0,0,${at},'{"identity":{"host":"github.com","repositoryNodeId":"R_repository"}}')`;
      const lifecycle = yield* ProjectLifecycle;
      yield* lifecycle.permanentDelete(deletion("a"));
      for (const table of [
        "project_issue_binding",
        "project_issue_repository_legacy",
        "project_issue_page",
        "project_issue_external",
        "project_issue_repository",
        "project_team_intake_cursor",
      ])
        expect(yield* sql`SELECT * FROM ${sql(table)}`).toHaveLength(0);
      expect(yield* sql`SELECT * FROM project_team_issue WHERE project_id='b'`).toHaveLength(1);
      expect(yield* sql`SELECT * FROM project_work_events WHERE project_id='b'`).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "deletion preserves another explicit binding without needing an issue and fences delayed writes",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql, "a");
      yield* bind(sql, "b");
      yield* history(sql);
      const old = (yield* claim(sql))!;
      const lifecycle = yield* ProjectLifecycle;
      yield* lifecycle.permanentDelete(deletion("a"));
      expect(
        yield* sql`SELECT * FROM project_issue_repository_legacy WHERE project_id='a'`,
      ).toHaveLength(0);
      expect(yield* sql`SELECT project_id AS projectId FROM project_issue_binding`).toEqual([
        { projectId: "b" },
      ]);
      expect(yield* sql`SELECT project_id AS projectId FROM project_team_intake_cursor`).toEqual([
        { projectId: "b" },
      ]);
      expect(yield* sql`SELECT * FROM project_issue_page`).toHaveLength(1);
      expect(yield* sql`SELECT * FROM project_issue_external`).toHaveLength(1);
      const after = (yield* readIssueRepositoryState(sql, key))!;
      expect(after.lease).toBeNull();
      expect(after.since).toBe(old.since);
      expect(after.nextPage).toBe(old.nextPage);
      expect(after.authorityGeneration).toBe(old.authorityGeneration + 1);
      expect(
        (yield* claim(sql, "new-read"))?.lease?.bindings.map((entry) => entry.projectId),
      ).toEqual(["b"]);
      yield* lifecycle.permanentDelete(deletion("b"));
      for (const table of [
        "project_issue_binding",
        "project_issue_page",
        "project_issue_external",
        "project_issue_repository",
        "project_team_intake_cursor",
      ])
        expect(yield* sql`SELECT * FROM ${sql(table)}`).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "late deletion receipt failure rolls back binding, lease, cache and raw history retirement",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql, "a");
      yield* bind(sql, "b");
      yield* history(sql);
      const old = yield* claim(sql);
      yield* sql`CREATE TRIGGER fail_delete_receipt BEFORE INSERT ON project_lifecycle_operations BEGIN SELECT RAISE(ABORT,'late failure'); END`;
      const lifecycle = yield* ProjectLifecycle;
      expect((yield* lifecycle.permanentDelete(deletion("a")).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* readIssueRepositoryState(sql, key)).toEqual(old);
      expect(yield* sql`SELECT * FROM project_issue_binding WHERE status='active'`).toHaveLength(2);
      expect(
        yield* sql`SELECT * FROM project_issue_repository_legacy WHERE project_id='a'`,
      ).toHaveLength(1);
      expect(yield* sql`SELECT project_id AS projectId FROM project_team_intake_cursor`).toEqual([
        { projectId: "a" },
      ]);
      expect(yield* sql`SELECT * FROM project_lifecycle`).toHaveLength(0);
      expect(yield* sql`SELECT * FROM project_work_events WHERE project_id='b'`).toHaveLength(0);
      yield* sql`DROP TRIGGER fail_delete_receipt`;
      yield* lifecycle.permanentDelete(deletion("a"));
      expect(yield* sql`SELECT * FROM project_issue_binding WHERE project_id='a'`).toHaveLength(0);
      expect(
        yield* sql`SELECT * FROM project_issue_repository_legacy WHERE project_id='a'`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
);
