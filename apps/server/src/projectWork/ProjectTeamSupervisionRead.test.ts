import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  ProjectTeamRecord,
  ProjectTeamSupervisionSummary,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { persistProjectTeamProjections } from "./ProjectTeamsPersistence.ts";
import { readProjectTeamSupervision } from "./ProjectTeamSupervisionRead.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { readProjectTeamBindingAccountingInTransaction } from "./ProjectTeamUsageRead.ts";

const at = "2026-01-01T00:00:00.000Z";
const decodeRecord = Schema.decodeUnknownEffect(ProjectTeamRecord);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSummaryJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamSupervisionSummary),
);
const fixture = Effect.fn("supervisionFixture")(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const project of ["project-a", "project-b"]) {
    yield* sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (${project},${project},'/disposable','[]',${at},${at})`;
    yield* sql`INSERT INTO project_work_events (event_id, project_id,event_type,occurred_at,command_id,payload_json)
      VALUES (${project},${project},'fixture',${at},${project},${yield* encodeJson({ projectId: project, revision: 20 })})`;
  }
  return sql;
});
const task = Effect.fn("supervisionTask")(function* (
  sql: SqlClient.SqlClient,
  taskId = "task",
  state = "ready",
  project = "project-a",
) {
  yield* sql`INSERT INTO project_work_tasks (task_id,project_id,title,state,revision,spec_revision,created_at,updated_at)
    VALUES (${taskId},${project},'Assigned task',${state},1,1,${at},${at})`;
});
const defaults = {
  mission: {
    status: "active",
    title: "Mission",
    objective: "PRIVATE OBJECTIVE",
    requiredTaskIds: [],
  },
  member: { status: "active", name: "Worker", coordinator: false, roleRevisionId: "role" },
  "role-revision": {
    status: "available",
    roleId: "profile",
    roleRevision: 3,
    role: "implementer",
    model: "current-profile-model",
    instructions: "PRIVATE INSTRUCTIONS",
    skills: [],
    tools: [],
    memoryAccess: "project",
    delegationDepth: 2,
  },
  "run-binding": {
    status: "running",
    taskId: "task",
    attemptId: "attempt",
    memberId: "worker",
    roleRevisionId: "role",
    providerInstanceId: "pi",
    threadId: "thread",
    environmentId: "environment",
    model: "frozen-binding-model",
    configuration: {
      instructionsHash: "PRIVATE CONFIGURATION",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 100,
      maxDurationMs: 100,
      paidFallback: false,
    },
    worktree: "PRIVATE WORKTREE",
    branch: "PRIVATE BRANCH",
    leaseGeneration: 0,
    specRevision: 1,
    planRevision: 1,
  },
  question: {
    status: "pending",
    taskId: "task",
    senderId: "worker",
    targetGateId: "gate",
    targetRevision: 1,
    body: "PRIVATE QUESTION",
    choices: [],
  },
  gate: {
    status: "pending",
    taskId: "task",
    gate: "execution",
    specRevision: 1,
    planRevision: 1,
    contentHash: "hash",
    evidenceIds: [],
    attribution: {
      actor: { kind: "human", id: "human" },
      source: { kind: "web", id: "client" },
      recordedAt: at,
    },
  },
};
const record = Effect.fn("supervisionRecord")(function* (
  sql: SqlClient.SqlClient,
  kind: keyof typeof defaults,
  recordId: string,
  fields: Record<string, unknown> = {},
  projectId = "project-a",
) {
  const value = yield* decodeRecord({
    kind,
    recordId,
    projectId,
    revision: 1,
    generation: 0,
    updatedAt: at,
    ...defaults[kind],
    ...fields,
  });
  yield* persistProjectTeamProjections(sql, projectId, [value], []);
});
const ownedRun = Effect.fn("supervisionOwnedRun")(function* (sql: SqlClient.SqlClient) {
  yield* task(sql);
  yield* sql`INSERT INTO project_work_attempts (attempt_id,project_id,task_id,state,checkpoint_ids_json,revision,updated_at)
    VALUES ('attempt','project-a','task','running','[]',1,${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at)
    VALUES ('thread','project-a','Worker','{"provider":"pi","model":"ordinary-thread-model"}',${at},${at})`;
  yield* record(sql, "role-revision", "role");
  yield* record(sql, "member", "worker");
  yield* record(sql, "run-binding", "run");
});
const summary = Effect.fn("supervisionSummary")(function* (
  sql: SqlClient.SqlClient,
  projectId = "project-a",
) {
  const value = yield* readProjectTeamSupervision(sql, { projectId });
  if (value.availability !== "available")
    return yield* Effect.die(new Error("Expected available project"));
  return value;
});
const isolated = <E>(name: string, body: () => Effect.Effect<void, E, SqlClient.SqlClient>) =>
  it.effect(name, () => body().pipe(Effect.provide(NodeSqliteClient.layerMemory())));

isolated(
  "reports an unadmitted assignment without inventing recorded usage from configuration",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      const before = yield* sql`SELECT * FROM project_team_run_binding WHERE record_id='run'`;
      expect(yield* sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_pi_operation`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_model_budget`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_model_request`).toEqual([]);
      const result = yield* readProjectTeamSupervision(sql, { projectId: "project-a" }).pipe(
        Effect.provideService(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        }),
      );
      const publicResult = yield* decodeSummaryJson(yield* encodeJson(result));
      expect(publicResult).toMatchObject({
        availability: "available",
        revision: 20,
        bindings: {
          items: [
            {
              recordId: "run",
              taskId: "task",
              attemptId: "attempt",
              accounting: {
                availability: "not-admitted",
                environmentId: "environment",
                projectId: "project-a",
                bindingId: "run",
                generation: 0,
                taskId: "task",
                attemptId: "attempt",
                observedAt: expect.any(String),
              },
            },
          ],
        },
      });
      expect(yield* sql`SELECT * FROM project_team_run_binding WHERE record_id='run'`).toEqual(
        before,
      );
      expect(yield* sql`SELECT * FROM project_team_model_budget`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_model_request`).toEqual([]);
    }),
);

isolated(
  "degrades accounting for oversized physical binding identity without inventing zero usage",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      const before =
        yield* sql`SELECT payload_json FROM project_team_run_binding WHERE record_id='run'`;
      for (const column of ["generation", "task_id", "attempt_id"]) {
        yield* sql`UPDATE project_team_run_binding SET ${sql(column)}=${"x".repeat(1100000)} WHERE record_id='run'`;
        const observation = yield* sql
          .withTransaction(
            readProjectTeamBindingAccountingInTransaction(sql, "project-a", [
              {
                recordId: "run",
                taskId: "task",
                attemptId: "attempt",
                generation: 0,
              },
            ]),
          )
          .pipe(
            Effect.provideService(ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
            }),
          );
        expect(observation, column).toMatchObject([
          {
            availability: "unavailable",
            reason: "read-bound",
            bindingId: "run",
          },
        ]);
        expect(
          yield* sql`SELECT payload_json FROM project_team_run_binding WHERE record_id='run'`,
        ).toEqual(before);
        yield* sql`UPDATE project_team_run_binding SET generation=0,task_id='task',attempt_id='attempt' WHERE record_id='run'`;
      }
      expect(yield* sql`SELECT * FROM project_team_model_request`).toEqual([]);
    }),
);

for (const [label, caption, expected] of [
  ["240 ASCII units", "A".repeat(240), "A".repeat(240)],
  ["239 ASCII units plus emoji", "A".repeat(239) + "😀", "A".repeat(239)],
  ["121 emoji", "😀".repeat(121), "😀".repeat(120)],
] as const) {
  isolated("bounds Unicode mission/coordinator/blocker captions: " + label, () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* task(sql);
      yield* record(sql, "mission", "mission", { title: caption });
      yield* record(sql, "member", "coordinator", { coordinator: true, name: caption });
      yield* sql`INSERT INTO project_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,revision)
        VALUES ('blocker','project-a','task',${caption},'human','[]',1,1)`;
      const value = yield* summary(sql);
      expect(value.missions.items[0]).toEqual(
        expect.objectContaining({ title: expected, supported: true }),
      );
      expect(value.coordinator).toEqual(
        expect.objectContaining({ name: expected, supported: true }),
      );
      expect(value.blockers.items[0]?.reason).toBe(expected);
      expect(expected.length).toBeLessThanOrEqual(240);
    }),
  );
}

for (const [label, threadId, navigate] of [
  ["256-unit identity", "t".repeat(256), true],
  ["257-unit identity", "t".repeat(257), false],
  ["leading whitespace", " thread", false],
  ["trailing whitespace", "thread ", false],
  ["blank identity", "   ", false],
] as const) {
  isolated("keeps inspection metadata with bounded exact worker navigation: " + label, () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      yield* sql`UPDATE projection_threads SET thread_id=${threadId} WHERE thread_id='thread'`;
      yield* sql`UPDATE project_team_run_binding SET thread_id=${threadId},payload_json=json_set(payload_json,'$.threadId',${threadId}) WHERE record_id='run'`;
      const value = (yield* summary(sql)).bindings.items[0];
      expect(value).toEqual(
        expect.objectContaining({ model: "frozen-binding-model", taskId: "task", supported: true }),
      );
      if (navigate) expect(value).toHaveProperty("workerThreadId", threadId);
      else expect(value).not.toHaveProperty("workerThreadId");
    }),
  );
}

for (const [label, ownerRevision] of [
  ["future", 21],
  ["negative", -1],
  ["fractional", 1.5],
  ["text", "invalid"],
  ["unsafe", 9_007_199_254_740_992],
] as const) {
  for (const owner of ["attempt", "gate"] as const) {
    isolated("returns only a physical marker for " + label + " " + owner + " owner revision", () =>
      Effect.gen(function* () {
        const sql = yield* fixture();
        yield* ownedRun(sql);
        yield* record(sql, "gate", "gate");
        yield* record(sql, "question", "question");
        yield* sql`PRAGMA ignore_check_constraints=ON`;
        if (owner === "attempt")
          yield* sql`UPDATE project_work_attempts SET revision=${ownerRevision} WHERE attempt_id='attempt'`;
        else
          yield* sql`UPDATE project_team_gate SET revision=${ownerRevision} WHERE record_id='gate'`;
        const value = yield* summary(sql);
        expect(owner === "attempt" ? value.bindings.items : value.questions.items).toEqual([
          {
            recordId: owner === "attempt" ? "run" : "question",
            revision: 1,
            status: owner === "attempt" ? "running" : "pending",
            supported: false,
            issue: "malformed",
          },
        ]);
      }),
    );
  }
}

isolated("reads empty projected projects and preserves their independent revision", () =>
  Effect.gen(function* () {
    const sql = yield* fixture();
    yield* sql`DELETE FROM project_work_events WHERE project_id='project-a'`;
    const value = yield* summary(sql);
    expect(value.revision).toBe(0);
    expect(value.taskCounts).toEqual({
      draft: 0,
      specified: 0,
      ready: 0,
      "in-progress": 0,
      blocked: 0,
      "in-review": 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      unknown: 0,
      total: 0,
    });
    expect(value.coordinator).toBeUndefined();
    expect(value.missions).toEqual({ items: [], hasMore: false });
    expect((yield* summary(sql, "project-b")).revision).toBe(20);
  }),
);

isolated(
  "counts nine fixed buckets and many distinct unknown states without cross-project records",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      const states = [
        "draft",
        "specified",
        "ready",
        "in-progress",
        "blocked",
        "in-review",
        "completed",
        "failed",
        "canceled",
      ];
      for (const state of states) yield* task(sql, state, state);
      for (let i = 0; i < 200; i++) yield* task(sql, "future-" + i, "future-" + i);
      yield* task(sql, "other", "ready", "project-b");
      expect((yield* summary(sql)).taskCounts).toEqual({
        draft: 1,
        specified: 1,
        ready: 1,
        "in-progress": 1,
        blocked: 1,
        "in-review": 1,
        completed: 1,
        failed: 1,
        canceled: 1,
        unknown: 200,
        total: 209,
      });
      expect((yield* summary(sql, "project-b")).taskCounts.total).toBe(1);
    }),
);

isolated(
  "bounds sentinel previews and prioritizes unresolved recorded statuses over revoked/future rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      yield* record(sql, "gate", "gate");
      yield* sql`UPDATE project_team_run_binding SET status='settled' WHERE record_id='run'`;
      for (let i = 0; i < 12; i++) {
        const id = String(i).padStart(2, "0");
        yield* record(sql, "mission", "mission-" + id, { title: "T".repeat(4000) });
        yield* record(sql, "run-binding", "old-" + id, { status: "revoked" });
        yield* record(sql, "question", "future-" + id);
        yield* sql`UPDATE project_team_question SET status='future',payload_json=json_set(payload_json,'$.status','future') WHERE record_id=${"future-" + id}`;
        yield* sql`INSERT INTO project_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,revision)
      VALUES (${"blocker-" + id},'project-a','task',${"R".repeat(4000)},'human','[]',1,1)`;
      }
      for (const [i, status] of ["reserved", "running", "stopping", "quarantined"].entries()) {
        yield* sql`INSERT INTO project_work_attempts (attempt_id,project_id,task_id,state,checkpoint_ids_json,revision,updated_at)
      VALUES (${"attempt-" + i},'project-a','task','settled','[]',1,${at})`;
        yield* record(sql, "run-binding", "new-" + i, { status, attemptId: "attempt-" + i });
      }
      for (let i = 0; i < 6; i++) yield* record(sql, "question", "pending-" + i);
      yield* record(sql, "mission", "foreign", {}, "project-b");
      const value = yield* summary(sql);
      expect(value.missions.items.map((x) => x.recordId)).toEqual([
        "mission-00",
        "mission-01",
        "mission-02",
        "mission-03",
        "mission-04",
      ]);
      expect(value.missions.items[0]).toEqual(expect.objectContaining({ title: "T".repeat(240) }));
      expect(value.bindings.items.slice(0, 4).map((x) => x.status)).toEqual([
        "running",
        "stopping",
        "quarantined",
        "reserved",
      ]);
      expect(value.bindings.items).toHaveLength(8);
      expect(value.questions.items.map((x) => x.recordId)).toEqual([
        "pending-0",
        "pending-1",
        "pending-2",
        "pending-3",
        "pending-4",
      ]);
      expect(value.blockers.items).toHaveLength(5);
      expect(value.blockers.items[0]?.reason).toHaveLength(240);
      expect([
        value.missions.hasMore,
        value.bindings.hasMore,
        value.blockers.hasMore,
        value.questions.hasMore,
      ]).toEqual([true, true, true, true]);
    }),
);

isolated(
  "resolves exact coordinator and frozen run profiles while omitting full bodies and preserving authoritative rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      yield* record(sql, "role-revision", "coordinator-role", {
        role: "coordinator",
        roleRevision: 7,
        model: "coordinator-model",
      });
      yield* record(sql, "member", "coordinator", {
        coordinator: true,
        name: "Coordinator",
        roleRevisionId: "coordinator-role",
      });
      yield* record(sql, "role-revision", "new-current-role", {
        roleRevision: 8,
        model: "changed-model",
      });
      yield* sql`UPDATE project_team_member SET payload_json=json_set(payload_json,'$.roleRevisionId','new-current-role') WHERE record_id='worker'`;
      yield* record(sql, "mission", "mission");
      yield* record(sql, "gate", "gate");
      yield* record(sql, "question", "question");
      const before =
        yield* sql`SELECT payload_json FROM project_team_run_binding UNION ALL SELECT payload_json FROM project_work_events`;
      const value = yield* summary(sql);
      expect(value.coordinator).toEqual(
        expect.objectContaining({
          name: "Coordinator",
          profile: expect.objectContaining({
            recordId: "coordinator-role",
            role: "coordinator",
            roleRevision: 7,
            model: "coordinator-model",
          }),
        }),
      );
      expect(value.bindings.items[0]).toEqual(
        expect.objectContaining({
          model: "frozen-binding-model",
          workerThreadId: "thread",
          profile: expect.objectContaining({
            recordId: "role",
            roleRevision: 3,
            model: "current-profile-model",
          }),
        }),
      );
      const encoded = yield* encodeJson(value);
      expect(encoded).not.toContain("PRIVATE");
      expect(encoded).not.toContain("payload_json");
      expect(encoded).not.toContain("ordinary-thread-model");
      expect(
        yield* sql`SELECT payload_json FROM project_team_run_binding UNION ALL SELECT payload_json FROM project_work_events`,
      ).toEqual(before);
    }),
);

isolated("keeps retired and unknown role/run statuses as inspection metadata", () =>
  Effect.gen(function* () {
    const sql = yield* fixture();
    yield* ownedRun(sql);
    yield* sql`UPDATE project_team_role_revision SET status='retired',payload_json=json_set(payload_json,'$.status','retired') WHERE record_id='role'`;
    expect((yield* summary(sql)).bindings.items[0]).toEqual(
      expect.objectContaining({ profile: expect.objectContaining({ status: "retired" }) }),
    );
    yield* sql`UPDATE project_team_role_revision SET status='future',payload_json=json_set(payload_json,'$.status','future') WHERE record_id='role'`;
    yield* sql`UPDATE project_team_run_binding SET status='future',payload_json=json_set(payload_json,'$.status','future') WHERE record_id='run'`;
    const value = yield* summary(sql);
    expect(value.bindings.items[0]).toEqual(
      expect.objectContaining({
        status: "future",
        supported: false,
        profile: expect.objectContaining({ status: "future", supported: false }),
      }),
    );
  }),
);

isolated("does not expose model/task/thread fields from malformed or foreign JSON", () =>
  Effect.gen(function* () {
    const sql = yield* fixture();
    yield* ownedRun(sql);
    yield* sql`UPDATE project_team_run_binding SET payload_json=json_set(payload_json,'$.projectId','project-b') WHERE record_id='run'`;
    expect((yield* summary(sql)).bindings.items).toEqual([
      { recordId: "run", revision: 1, status: "running", supported: false, issue: "malformed" },
    ]);
    yield* sql`UPDATE project_team_run_binding SET payload_json='{' WHERE record_id='run'`;
    expect((yield* summary(sql)).bindings.items).toEqual([
      { recordId: "run", revision: 1, status: "running", supported: false, issue: "malformed" },
    ]);
    yield* record(sql, "mission", "mission");
    yield* sql`UPDATE project_team_mission SET revision=21 WHERE record_id='mission'`;
    expect((yield* summary(sql)).missions.items).toEqual([
      { recordId: "mission", revision: 21, status: "active", supported: false, issue: "malformed" },
    ]);
  }),
);

isolated(
  "resolves no foreign profile and grants no link to another or deleted project's worker thread",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      yield* sql`UPDATE project_team_role_revision SET project_id='project-b',payload_json=json_set(payload_json,'$.projectId','project-b') WHERE record_id='role'`;
      yield* sql`UPDATE projection_threads SET project_id='project-b' WHERE thread_id='thread'`;
      const value = yield* summary(sql);
      expect(value.bindings.items[0]).not.toHaveProperty("workerThreadId");
      expect(value.bindings.items[0]).toHaveProperty("profile", undefined);
      yield* sql`UPDATE projection_threads SET project_id='project-a',deleted_at=${at} WHERE thread_id='thread'`;
      expect((yield* summary(sql)).bindings.items[0]).not.toHaveProperty("workerThreadId");
    }),
);

for (const [state, deleted, want] of [
  ["active", true, "deleted"],
  ["archived", false, "archived"],
  ["tombstoned", false, "tombstoned"],
] as const) {
  isolated("returns only unavailability for " + want + " projects", () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* ownedRun(sql);
      yield* sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at)
      VALUES ('project-a',${state},'/disposable',3,${at})`;
      if (deleted)
        yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id='project-a'`;
      expect(yield* readProjectTeamSupervision(sql, { projectId: "project-a" })).toEqual({
        projectId: "project-a",
        availability: want,
      });
      yield* sql`DELETE FROM projection_projects WHERE project_id='project-a'`;
      expect(yield* readProjectTeamSupervision(sql, { projectId: "project-a" })).toEqual({
        projectId: "project-a",
        availability: state === "tombstoned" ? "tombstoned" : "missing",
      });
    }),
  );
}

isolated(
  "returns missing for unknown projects and unsupported for an unknown projected lifecycle",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      expect(yield* readProjectTeamSupervision(sql, { projectId: "missing" })).toEqual({
        projectId: "missing",
        availability: "missing",
      });
      yield* sql`PRAGMA ignore_check_constraints=ON`;
      yield* sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES ('project-a','future','/disposable',1,${at})`;
      expect(yield* readProjectTeamSupervision(sql, { projectId: "project-a" })).toEqual({
        projectId: "project-a",
        availability: "unsupported",
      });
    }),
);

isolated("fails coherently on a task or blocker ahead of the project fence", () =>
  Effect.gen(function* () {
    const sql = yield* fixture();
    yield* task(sql);
    yield* sql`UPDATE project_work_tasks SET revision=21 WHERE task_id='task'`;
    expect(
      (yield* readProjectTeamSupervision(sql, { projectId: "project-a" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_work_tasks SET revision=1 WHERE task_id='task'`;
    yield* sql`INSERT INTO project_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,revision)
    VALUES ('blocker','project-a','task','Reason','human','[]',1,21)`;
    expect(
      (yield* readProjectTeamSupervision(sql, { projectId: "project-a" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }),
);

isolated("preserves SQL/schema failures rather than manufacturing zero-success summaries", () =>
  Effect.gen(function* () {
    const sql = yield* fixture();
    for (const payload of [
      "{",
      '{"projectId":"project-a","revision":"20"}',
      '{"projectId":"project-b","revision":20}',
      '{"projectId":"project-a","revision":9007199254740992}',
    ]) {
      yield* sql`UPDATE project_work_events SET payload_json=${payload} WHERE project_id='project-a'`;
      const value = yield* readProjectTeamSupervision(sql, { projectId: "project-a" }).pipe(
        Effect.result,
      );
      expect(value._tag).toBe("Failure");
      if (value._tag === "Failure")
        expect(value.failure, payload).toEqual(
          expect.objectContaining({
            _tag:
              payload === "{" || payload.includes("9007199254740992")
                ? "PersistenceSqlError"
                : "PersistenceDecodeError",
          }),
        );
    }
    yield* sql`DROP TABLE project_work_events`;
    expect(
      (yield* readProjectTeamSupervision(sql, { projectId: "project-a" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }),
);
