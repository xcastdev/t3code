import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProjectWorkTaskId,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { PROJECT_WORK_CHECKPOINT_VERSION } from "./ProjectTeamsPersistence.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { compileProjectTeamConfiguration } from "./ProjectTeamConfiguration.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { makeProjectTeamSchedulingView } from "./ProjectTeamSchedulingView.ts";
import { makeProjectTeamScheduler } from "./ProjectTeamScheduler.ts";

const at = "2026-01-01T00:00:00.000Z";
const attribution = {
  actor: { kind: "human", id: "scheduler-test" },
  source: { kind: "web", id: "scheduler-test" },
  recordedAt: at,
} as const;
const runtime = ProjectWorkRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(runtime)));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const register = Effect.fn("schedulingTest.register")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const projectId = ProjectId.make(id);
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},${id},'/workspace','[]',${at},${at})`;
  return projectId;
});

const configure = Effect.fn("schedulingTest.configure")(function* (
  projectId: ProjectId,
  input: {
    projectPriority?: number;
    taskPriorities?: ProjectTeamConfigurationIntent["taskPriorities"];
    enabled?: boolean;
    models?: ReadonlyArray<string>;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ProjectWorkRepository;
  const state = yield* readCurrentState(sql, projectId);
  const models = input.models ?? ["model-a"];
  const intent: ProjectTeamConfigurationIntent = {
    type: "project-team.configure",
    commandId: CommandId.make(`${projectId}:configure:${state.revision}`),
    projectId,
    expectedRevision: state.revision,
    expectedConfigurationGeneration: Math.max(
      0,
      ...(state.foundationRecords ?? [])
        .filter((record) => record.kind === "limits")
        .map((record) => record.generation),
    ),
    enabled: input.enabled ?? true,
    providerInstanceId: ProviderInstanceId.make("pi-instance"),
    projectPriority: input.projectPriority ?? 0,
    taskPriorities: input.taskPriorities ?? [],
    profiles: models.map((model, index) => ({
      role: index === 0 ? "coordinator" : "implementer",
      instructions: "Use current project policy",
      skills: [],
      tools: ["read"],
      model,
      memoryAccess: "project",
      delegationDepth: 0,
    })),
    modelPolicies: models.map((model, index) => ({
      model,
      tokenLimit: 4096 + index,
      durationLimitMs: 60000 + index,
      modelCalls: 1 + index,
    })),
  };
  yield* repo.execute(compileProjectTeamConfiguration(state, intent, attribution));
});

const createTask = Effect.fn("schedulingTest.createTask")(function* (
  projectId: ProjectId,
  id: string,
) {
  const repo = yield* ProjectWorkRepository;
  const taskId = ProjectWorkTaskId.make(id);
  yield* repo.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make(`${projectId}:${id}`),
    title: id,
    createdAt: at,
  });
  return taskId;
});

// Corrupt only a disposable derived cache; the production authority loader still runs.
const replaceCheckpoint = Effect.fn("schedulingTest.replaceCheckpoint")(function* (
  projectId: ProjectId,
  change: (state: ProjectWorkReducerState) => unknown,
) {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* readCurrentState(sql, projectId);
  const changed = change(state);
  const payload = yield* encodeJson(changed);
  yield* sql`UPDATE project_work_reducer_checkpoints SET state_json = ${payload}
    WHERE project_id = ${projectId}`;
});

const assertPolicyDenied = Effect.fn("schedulingTest.assertPolicyDenied")(function* (
  projectId: ProjectId,
) {
  const view = yield* makeProjectTeamSchedulingView();
  expect(yield* view.readProjectPage({ limit: 32 })).toEqual([{ projectId, priority: 0 }]);
  const result = yield* view.readProjectState({ projectId, limit: 64 }).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(ProjectWorkPolicyError);
    expect(result.failure._tag).toBe("ProjectWorkPolicyError");
  }
});

it.effect("reads installed project priority and refreshes it after reconfiguration", () =>
  scoped(
    Effect.gen(function* () {
      const projectId = yield* register("priority-project");
      yield* configure(projectId, { projectPriority: 7 });
      const view = yield* makeProjectTeamSchedulingView();
      expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
        { projectId: "priority-project", priority: 7 },
      ]);
      yield* configure(projectId, { projectPriority: -3 });
      expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
        { projectId: "priority-project", priority: -3 },
      ]);
    }),
  ),
);

it.effect("rejects malformed physical IDs before they can change a SQL keyset cursor", () =>
  scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const valid = yield* register("B-healthy");
      yield* configure(valid, { projectPriority: 10 });
      yield* sql`INSERT INTO projection_projects
        (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (' a','Malformed identity','/workspace','[]',${at},${at})`;
      const view = yield* makeProjectTeamSchedulingView();
      const first = yield* view.readProjectPage({ limit: 1 }).pipe(Effect.result);
      expect(first._tag).toBe("Failure");
      if (first._tag === "Failure") expect(first.failure).toBeInstanceOf(ProjectWorkPolicyError);
      expect(yield* sql`SELECT project_id FROM projection_projects ORDER BY project_id`).toEqual([
        { project_id: " a" },
        { project_id: valid },
      ]);
      yield* sql`DELETE FROM projection_projects WHERE project_id = ' a'`;
      expect(yield* view.readProjectPage({ limit: 1 })).toEqual([
        { projectId: valid, priority: 10 },
      ]);
    }),
  ),
);

it.effect("rejects raw request identities instead of silently trimming them", () =>
  scoped(
    Effect.gen(function* () {
      const projectId = yield* register("B-healthy");
      yield* createTask(projectId, "task-a");
      yield* createTask(projectId, "task-b");
      yield* configure(projectId);
      const view = yield* makeProjectTeamSchedulingView();
      for (const result of [
        yield* view
          .readProjectPage({ afterProjectId: ProjectId.make(" B-healthy"), limit: 1 })
          .pipe(Effect.result),
        yield* view
          .readProjectState({ projectId: ProjectId.make(" B-healthy"), limit: 1 })
          .pipe(Effect.result),
        yield* view
          .readProjectState({ projectId, afterTaskId: ProjectWorkTaskId.make(" task-a"), limit: 1 })
          .pipe(Effect.result),
      ]) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(ProjectWorkPolicyError);
      }
      expect(
        (yield* view.readProjectState({
          projectId,
          afterTaskId: ProjectWorkTaskId.make("task-a"),
          limit: 1,
        })).candidates,
      ).toEqual([{ taskId: "task-b", priority: 0 }]);
    }),
  ),
);

it.effect("keeps project keyset order and advances past a full disabled window", () =>
  scoped(
    Effect.gen(function* () {
      for (let index = 0; index < 70; index++) {
        const projectId = yield* register(`project-${String(index).padStart(2, "0")}`);
        if (index < 32) yield* configure(projectId, { enabled: false, projectPriority: 99 });
        if (index === 33) yield* configure(projectId, { projectPriority: 12 });
      }
      const view = yield* makeProjectTeamSchedulingView();
      const first = yield* view.readProjectPage({ limit: 32 });
      expect(first).toHaveLength(32);
      expect(first[0]).toEqual({ projectId: "project-00", priority: 0 });
      expect(first[31]).toEqual({ projectId: "project-31", priority: 0 });
      const second = yield* view.readProjectPage({
        afterProjectId: first[31]!.projectId,
        limit: 32,
      });
      expect(second).toHaveLength(32);
      expect(second[0]).toEqual({ projectId: "project-32", priority: 0 });
      expect(second[1]).toEqual({ projectId: "project-33", priority: 12 });
      expect(second[31]).toEqual({ projectId: "project-63", priority: 0 });
      const third = yield* view.readProjectPage({
        afterProjectId: second[31]!.projectId,
        limit: 32,
      });
      expect(third.map((entry) => entry.projectId)).toEqual([
        "project-64",
        "project-65",
        "project-66",
        "project-67",
        "project-68",
        "project-69",
      ]);
      expect(new Set([...first, ...second, ...third].map((entry) => entry.projectId)).size).toBe(
        70,
      );
      expect(
        yield* view.readProjectPage({ afterProjectId: third[5]!.projectId, limit: 32 }),
      ).toEqual([]);
    }),
  ),
);

it.effect("reads complete task authority with bounded candidates in ID order", () =>
  scoped(
    Effect.gen(function* () {
      const projectId = yield* register("task-project");
      for (let index = 69; index >= 0; index--)
        yield* createTask(projectId, `task-${String(index).padStart(2, "0")}`);
      yield* configure(projectId, {
        models: ["model-a", "model-b"],
        taskPriorities: [
          { taskId: ProjectWorkTaskId.make("task-69"), priority: 20 },
          { taskId: ProjectWorkTaskId.make("task-01"), priority: -2 },
        ],
      });
      const view = yield* makeProjectTeamSchedulingView();
      const first = yield* view.readProjectState({ projectId, limit: 64 });
      expect(first.state.tasks).toHaveLength(70);
      expect(first.state.criteria).toEqual([]);
      expect(first.state.history!.length).toBeGreaterThan(70);
      expect(first.candidates).toHaveLength(64);
      expect(first.candidates[0]).toEqual({ taskId: "task-00", priority: 0 });
      expect(first.candidates[1]).toEqual({ taskId: "task-01", priority: -2 });
      expect(first.candidates[63]).toEqual({ taskId: "task-63", priority: 0 });
      const second = yield* view.readProjectState({
        projectId,
        afterTaskId: first.candidates[63]!.taskId,
        limit: 64,
      });
      expect(second.candidates).toEqual([
        { taskId: "task-64", priority: 0 },
        { taskId: "task-65", priority: 0 },
        { taskId: "task-66", priority: 0 },
        { taskId: "task-67", priority: 0 },
        { taskId: "task-68", priority: 0 },
        { taskId: "task-69", priority: 20 },
      ]);
      expect(
        new Set([...first.candidates, ...second.candidates].map((entry) => entry.taskId)).size,
      ).toBe(70);
      yield* configure(projectId, {
        taskPriorities: [{ taskId: ProjectWorkTaskId.make("task-69"), priority: -8 }],
      });
      expect(
        (yield* view.readProjectState({
          projectId,
          afterTaskId: ProjectWorkTaskId.make("task-68"),
          limit: 64,
        })).candidates,
      ).toEqual([{ taskId: "task-69", priority: -8 }]);
    }),
  ),
);

it.effect("does not use stale physical limits or task projections as authority", () =>
  scoped(
    Effect.gen(function* () {
      const projectId = yield* register("stale-project");
      yield* createTask(projectId, "current-task");
      yield* configure(projectId, {
        projectPriority: 9,
        taskPriorities: [{ taskId: ProjectWorkTaskId.make("current-task"), priority: 11 }],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM project_work_tasks WHERE project_id = ${projectId}`;
      yield* sql`UPDATE project_team_limits SET status = 'disabled', payload_json = '{}'
        WHERE project_id = ${projectId}`;
      const view = yield* makeProjectTeamSchedulingView();
      expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
        { projectId: "stale-project", priority: 9 },
      ]);
      expect((yield* view.readProjectState({ projectId, limit: 64 })).candidates).toEqual([
        { taskId: "current-task", priority: 11 },
      ]);
      yield* configure(projectId, { enabled: false, projectPriority: 99 });
      yield* sql`UPDATE project_team_limits SET status = 'configured' WHERE project_id = ${projectId}`;
      expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
        { projectId: "stale-project", priority: 0 },
      ]);
      const disabled = yield* view.readProjectState({ projectId, limit: 64 });
      expect(disabled.state.tasks).toHaveLength(1);
      expect(disabled.candidates).toEqual([]);
    }),
  ),
);

it.effect(
  "returns no task candidates without configured limits and defaults legacy priorities to zero",
  () =>
    scoped(
      Effect.gen(function* () {
        const projectId = yield* register("legacy-project");
        yield* createTask(projectId, "legacy-task");
        const view = yield* makeProjectTeamSchedulingView();
        expect((yield* view.readProjectState({ projectId, limit: 64 })).candidates).toEqual([]);
        yield* configure(projectId, { projectPriority: 4 });
        yield* replaceCheckpoint(projectId, (state) => ({
          ...state,
          checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
          foundationRecords: state.foundationRecords!.map((record) => {
            if (record.kind !== "limits") return record;
            const {
              projectPriority: _projectPriority,
              taskPriorities: _taskPriorities,
              providerInstanceId: _providerInstanceId,
              profileRecordIds: _profileRecordIds,
              ...legacy
            } = record;
            return legacy;
          }),
        }));
        expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
          { projectId: "legacy-project", priority: 0 },
        ]);
        expect((yield* view.readProjectState({ projectId, limit: 64 })).candidates).toEqual([
          { taskId: "legacy-task", priority: 0 },
        ]);
      }),
    ),
);

for (const state of ["archived", "tombstoned"] as const)
  it.effect(`omits ${state} projects and denies a previously selected project`, () =>
    scoped(
      Effect.gen(function* () {
        const projectId = yield* register(`lifecycle-${state}`);
        yield* configure(projectId, { projectPriority: 4 });
        const sql = yield* SqlClient.SqlClient;
        const view = yield* makeProjectTeamSchedulingView();
        expect(yield* view.readProjectPage({ limit: 32 })).toHaveLength(1);
        yield* sql`INSERT INTO project_lifecycle
          (project_id,state,workspace_root,changed_at) VALUES (${projectId},${state},'/workspace',${at})`;
        expect(yield* view.readProjectPage({ limit: 32 })).toEqual([]);
        const result = yield* view.readProjectState({ projectId, limit: 64 }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(ProjectWorkPolicyError);
      }),
    ),
  );

it.effect("omits deleted and missing projects and permits explicit active lifecycle rows", () =>
  scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const deleted = yield* register("deleted-project");
      const active = yield* register("active-project");
      yield* sql`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = ${deleted}`;
      yield* sql`INSERT INTO project_lifecycle
        (project_id,state,workspace_root,changed_at) VALUES (${active},'active','/workspace',${at})`;
      const view = yield* makeProjectTeamSchedulingView();
      expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
        { projectId: "active-project", priority: 0 },
      ]);
      for (const projectId of [deleted, ProjectId.make("missing-project")]) {
        const result = yield* view.readProjectState({ projectId, limit: 64 }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(ProjectWorkPolicyError);
      }
    }),
  ),
);

for (const corrupt of [
  {
    name: "duplicate task priorities",
    fields: {
      taskPriorities: [
        { taskId: "known-task", priority: 1 },
        { taskId: "known-task", priority: 2 },
      ],
    },
  },
  {
    name: "unknown task priorities",
    fields: { taskPriorities: [{ taskId: "unknown-task", priority: 1 }] },
  },
  { name: "malformed priorities", fields: { projectPriority: 0.5 } },
  { name: "cross project policy", fields: { projectId: "foreign-project" } },
])
  it.effect(`denies ${corrupt.name} in current configured policy`, () =>
    scoped(
      Effect.gen(function* () {
        const projectId = yield* register("malformed-project");
        yield* createTask(projectId, "known-task");
        yield* configure(projectId);
        yield* replaceCheckpoint(projectId, (state) => ({
          ...state,
          checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
          foundationRecords: state.foundationRecords!.map((record) =>
            record.kind === "limits" ? { ...record, ...corrupt.fields } : record,
          ),
        }));
        yield* assertPolicyDenied(projectId);
      }),
    ),
  );

for (const mismatch of [
  { name: "project priorities", fields: { projectPriority: 5 } },
  { name: "task priorities", fields: { taskPriorities: [{ taskId: "known-task", priority: 2 }] } },
  { name: "configuration generations", fields: { generation: 2 } },
  { name: "provider instances", fields: { providerInstanceId: "other-pi" } },
  { name: "profile identities", fields: { profileRecordIds: ["other-profile"] } },
  { name: "environment capacity", fields: { environmentModelCalls: 3 } },
  { name: "project capacity", fields: { projectWritableWorkers: 3 } },
  { name: "model policies", fields: { model: "model-a" } },
])
  it.effect(`denies inconsistent configured ${mismatch.name}`, () =>
    scoped(
      Effect.gen(function* () {
        const projectId = yield* register("mixed-project");
        yield* createTask(projectId, "known-task");
        yield* configure(projectId, { models: ["model-a", "model-b"] });
        yield* replaceCheckpoint(projectId, (state) => ({
          ...state,
          checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
          foundationRecords: state.foundationRecords!.map((record) =>
            record.kind === "limits" && record.model === "model-b"
              ? { ...record, ...mismatch.fields }
              : record,
          ),
        }));
        yield* assertPolicyDenied(projectId);
      }),
    ),
  );

for (const fault of ["duplicate-policy", "duplicate-task", "foreign-task"] as const)
  it.effect(`denies ${fault} identities from current authority`, () =>
    scoped(
      Effect.gen(function* () {
        const projectId = yield* register("identity-project");
        yield* createTask(projectId, "known-task");
        yield* configure(projectId);
        yield* replaceCheckpoint(projectId, (state) => ({
          ...state,
          checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
          tasks:
            fault === "duplicate-task"
              ? [...state.tasks, state.tasks[0]]
              : fault === "foreign-task"
                ? state.tasks.map((task) => ({ ...task, projectId: "foreign-project" }))
                : state.tasks,
          foundationRecords:
            fault === "duplicate-policy"
              ? [
                  ...state.foundationRecords!,
                  state.foundationRecords!.find((record) => record.kind === "limits"),
                ]
              : state.foundationRecords,
        }));
        yield* assertPolicyDenied(projectId);
      }),
    ),
  );

it.effect("rejects invalid keyset bounds with policy errors", () =>
  scoped(
    Effect.gen(function* () {
      const projectId = yield* register("bounds-project");
      const view = yield* makeProjectTeamSchedulingView();
      for (const limit of [0, -1, 1.5, 33, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = yield* view.readProjectPage({ limit }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(ProjectWorkPolicyError);
      }
      for (const limit of [0, -1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = yield* view.readProjectState({ projectId, limit }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(ProjectWorkPolicyError);
      }
      expect(
        (yield* view
          .readProjectPage({ afterProjectId: ProjectId.make(" "), limit: 1 })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* view
          .readProjectState({ projectId, afterTaskId: ProjectWorkTaskId.make(" "), limit: 1 })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("preserves SQL failures instead of disguising them as missing configuration", () =>
  scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = yield* register("sql-project");
      const view = yield* makeProjectTeamSchedulingView();
      yield* sql`DROP TABLE project_work_reducer_checkpoints`;
      for (const result of [
        yield* view.readProjectPage({ limit: 32 }).pipe(Effect.result),
        yield* view.readProjectState({ projectId, limit: 64 }).pipe(Effect.result),
      ]) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("SqlError");
      }
    }),
  ),
);

for (const read of ["projects", "tasks"] as const)
  it.effect(
    `keeps ${read} and priorities in one SQL snapshot during a committed concurrent write`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filename = `${directory}/state.sqlite`;
        return yield* Effect.gen(function* () {
          const projectId = yield* register("snapshot-project");
          yield* createTask(projectId, "snapshot-task");
          yield* configure(projectId, {
            projectPriority: 6,
            taskPriorities: [{ taskId: ProjectWorkTaskId.make("snapshot-task"), priority: 4 }],
          });
          const sql = yield* SqlClient.SqlClient;
          const state = yield* readCurrentState(sql, projectId);
          const payload = yield* encodeJson({
            ...state,
            checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
            tasks: state.tasks.map((task) => ({ ...task, title: "Changed during the read" })),
            foundationRecords: state.foundationRecords!.map((record) =>
              record.kind === "limits"
                ? {
                    ...record,
                    projectPriority: 50,
                    taskPriorities: [{ taskId: "snapshot-task", priority: 40 }],
                  }
                : record,
            ),
          });
          const writer = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (database) => Effect.sync(() => database.close()),
          );
          // Start a real WAL snapshot, then let a separate connection commit while the
          // view's transaction is held. Both view queries must retain that snapshot.
          const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT project_id FROM projection_projects`;
                yield* Effect.sync(() => {
                  writer
                    .prepare(
                      "UPDATE project_work_reducer_checkpoints SET state_json = ? WHERE project_id = ?",
                    )
                    .run(payload, projectId);
                  if (read === "projects")
                    writer
                      .prepare("UPDATE projection_projects SET deleted_at = ? WHERE project_id = ?")
                      .run(at, projectId);
                });
                return yield* effect;
              }),
            );
          const intercepted = new Proxy(sql, {
            get(target, key, receiver) {
              return key === "withTransaction"
                ? withTransaction
                : Reflect.get(target, key, receiver);
            },
          });
          const view = yield* makeProjectTeamSchedulingView().pipe(
            Effect.provideService(SqlClient.SqlClient, intercepted),
          );
          if (read === "projects") {
            expect(yield* view.readProjectPage({ limit: 32 })).toEqual([
              { projectId: "snapshot-project", priority: 6 },
            ]);
            expect(
              writer
                .prepare("SELECT deleted_at FROM projection_projects WHERE project_id = ?")
                .get(projectId),
            ).toEqual({ deleted_at: at });
          } else {
            const result = yield* view.readProjectState({ projectId, limit: 64 });
            expect(result.candidates).toEqual([{ taskId: "snapshot-task", priority: 4 }]);
            expect(result.state.tasks[0]!.title).toBe("snapshot-task");
          }
          const current = yield* readCurrentState(sql, projectId);
          expect(current.tasks[0]!.title).toBe("Changed during the read");
          const fresh = yield* makeProjectTeamSchedulingView();
          if (read === "projects") expect(yield* fresh.readProjectPage({ limit: 32 })).toEqual([]);
          else
            expect((yield* fresh.readProjectState({ projectId, limit: 64 })).candidates).toEqual([
              { taskId: "snapshot-task", priority: 40 },
            ]);
        }).pipe(
          Effect.provide(
            ProjectWorkRepositoryLive.pipe(Layer.provideMerge(makeSqlitePersistenceLive(filename))),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

it.effect("sweeps SQLite project keysets across high BMP and astral IDs without skipping", () =>
  scoped(
    Effect.gen(function* () {
      const highBmp = yield* register("unicode-\uE000");
      const astral = yield* register("unicode-\u{10000}");
      for (const projectId of [highBmp, astral]) {
        yield* createTask(projectId, `task-${projectId}`);
        yield* configure(projectId, { projectPriority: 1 });
      }
      const view = yield* makeProjectTeamSchedulingView();
      const scheduler = yield* makeProjectTeamScheduler({
        environmentId: "unicode-environment",
        ports: {
          ...view,
          prepareRequest: () =>
            Effect.succeed({ _tag: "Blocked", reason: "no managed membership" }),
          reserve: () => Effect.die("Unexpected reservation"),
        },
      });
      const visited: Array<ProjectId> = [];
      for (let index = 0; index < 3; index++) {
        const result = yield* scheduler.sweep({ projects: 1, tasksPerProject: 1 });
        visited.push(...result.blocked.map((entry) => entry.projectId));
      }
      expect(visited).toEqual([highBmp, astral]);
    }),
  ),
);

it.effect("sweeps task keysets in SQLite binary order with equal-priority ties", () =>
  scoped(
    Effect.gen(function* () {
      const projectId = yield* register("unicode-tasks");
      const astral = yield* createTask(projectId, "task-\u{10000}");
      const highBmp = yield* createTask(projectId, "task-\uE000");
      yield* configure(projectId);
      const view = yield* makeProjectTeamSchedulingView();
      const sql = yield* SqlClient.SqlClient;
      const physical = yield* sql<{ taskId: ProjectWorkTaskId }>`SELECT task_id AS taskId
        FROM project_work_tasks WHERE project_id = ${projectId} ORDER BY task_id ASC`;
      expect(physical.map((entry) => entry.taskId)).toEqual([highBmp, astral]);
      expect((yield* view.readProjectState({ projectId, limit: 1 })).candidates).toEqual([
        { taskId: highBmp, priority: 0 },
      ]);
      expect(
        (yield* view.readProjectState({ projectId, afterTaskId: highBmp, limit: 1 })).candidates,
      ).toEqual([{ taskId: astral, priority: 0 }]);
      const scheduler = yield* makeProjectTeamScheduler({
        environmentId: "unicode-environment",
        ports: {
          ...view,
          prepareRequest: () =>
            Effect.succeed({ _tag: "Blocked", reason: "no managed membership" }),
          reserve: () => Effect.die("Unexpected reservation"),
        },
      });
      const first = yield* scheduler.sweep({ projects: 1, tasksPerProject: 1 });
      const second = yield* scheduler.sweep({ projects: 1, tasksPerProject: 1 });
      const third = yield* scheduler.sweep({ projects: 1, tasksPerProject: 1 });
      expect(
        [...first.blocked, ...second.blocked, ...third.blocked].map((entry) => entry.taskId),
      ).toEqual([highBmp, astral]);
      const tied = yield* makeProjectTeamScheduler({
        environmentId: "unicode-environment",
        ports: {
          ...view,
          prepareRequest: () =>
            Effect.succeed({ _tag: "Blocked", reason: "no managed membership" }),
          reserve: () => Effect.die("Unexpected reservation"),
        },
      });
      expect(
        (yield* tied.sweep({ projects: 1, tasksPerProject: 2 })).blocked.map(
          (entry) => entry.taskId,
        ),
      ).toEqual([highBmp, astral]);
    }),
  ),
);

it.effect("breaks equal project priorities in SQLite binary order", () =>
  scoped(
    Effect.gen(function* () {
      const astral = yield* register("tie-\u{10000}");
      const highBmp = yield* register("tie-\uE000");
      for (const projectId of [astral, highBmp]) {
        yield* createTask(projectId, `task-${projectId}`);
        yield* configure(projectId, { projectPriority: 5 });
      }
      const view = yield* makeProjectTeamSchedulingView();
      const scheduler = yield* makeProjectTeamScheduler({
        environmentId: "unicode-environment",
        ports: {
          ...view,
          prepareRequest: () =>
            Effect.succeed({ _tag: "Blocked", reason: "no managed membership" }),
          reserve: () => Effect.die("Unexpected reservation"),
        },
      });
      expect(
        (yield* scheduler.sweep({ projects: 2, tasksPerProject: 1 })).blocked.map(
          (entry) => entry.projectId,
        ),
      ).toEqual([highBmp, astral]);
    }),
  ),
);
