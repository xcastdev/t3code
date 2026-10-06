import * as NodeCrypto from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkAttemptId,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamRecord,
  canonicalProjectWorkPayload,
  type ProjectTeamRecord as TeamRecord,
  type ProjectTeamGuidedIntent,
  type ProjectWorkCommand,
  type ProjectWorkPublicationRequest,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import { runMigrations, runForkMigrations } from "../persistence/Migrations.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import {
  ProjectWorkProjection,
  ProjectWorkProjectionLive,
  persistProjectWorkTaskCreated,
} from "./ProjectWorkProjection.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import {
  emptyProjectWorkProjectionState,
  applyProjectWorkProjectionEvents,
} from "./ProjectWorkProjection.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { PROJECT_WORK_CHECKPOINT_VERSION } from "./ProjectTeamsPersistence.ts";

const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const decodeTeamRecordEffect = Schema.decodeUnknownEffect(ProjectTeamRecord);
const at = "2026-01-01T00:00:00.000Z";
const attribution = {
  actor: { kind: "system", id: "foundation" },
  source: { kind: "system", id: "foundation" },
  recordedAt: at,
} as const;
const record = <Kind extends TeamRecord["kind"]>(
  project: string,
  kind: Kind,
  id: string,
  fields: Record<string, unknown>,
) => {
  const decoded = decodeTeamRecord({
    ...fields,
    kind,
    recordId: id,
    projectId: project,
    revision: 0,
    generation: 0,
    updatedAt: at,
  });
  // The schema verifies the variant and the discriminant is supplied by this fixture.
  return decoded as Extract<TeamRecord, { kind: Kind }>;
};
const commit = (
  project: string,
  id: string,
  revision: number,
  records: ReadonlyArray<TeamRecord>,
) =>
  decodeCommit({
    type: "project-work.foundation.commit",
    commandId: id,
    projectId: project,
    expectedRevision: revision,
    attribution,
    records,
    committedAt: at,
  });
const services = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  ProjectWorkProjectionLive,
  ProjectWorkQueryLive,
);
const prepareFoundationProject = Effect.fn("prepareFoundationProject")(function* (
  project: string,
  authorized = true,
) {
  const repo = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  const projectId = ProjectId.make(project);
  const taskId = ProjectWorkTaskId.make(project + "-task");
  yield* repo.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make(project + "-create"),
    title: "Delivery",
    createdAt: at,
  });
  const criterionId = ProjectWorkCriterionId.make(project + "-criterion");
  const criterion = {
    criterionId,
    taskId,
    description: "Recorded requirement",
    required: false,
    status: "unsatisfied" as const,
    satisfiedByEvidenceIds: [],
    revision: 0,
    updatedAt: at,
  };
  const specification = {
    objective: "Deliver",
    scopeIn: "Task",
    scopeOut: "Unrelated work",
    criterionIds: [criterionId],
    revision: 1,
    protected: false,
  };
  const humanAttribution = {
    actor: { kind: "human" as const, id: "maintainer" },
    source: { kind: "web" as const, id: "foundation-client" },
    recordedAt: at,
  };
  const guided = (intent: ProjectTeamGuidedIntent) =>
    repo.execute({
      type: "project-work.foundation.commit",
      projectId,
      commandId: intent.commandId,
      expectedRevision: intent.expectedRevision,
      records: [],
      committedAt: at,
      attribution: humanAttribution,
      guided: { intent },
    });
  const envelope = Effect.fn("foundationEnvelope")(function* (id: string) {
    const state = yield* readCurrentState(sql, projectId);
    return {
      projectId,
      taskId,
      commandId: CommandId.make(project + "-" + id),
      expectedRevision: state.revision,
      expectedTaskRevision: state.tasks.find((task) => task.taskId === taskId)!.revision,
    };
  });
  const approve = Effect.fn("approveFoundationGates")(function* () {
    const state = yield* readCurrentState(sql, projectId);
    const pending = state.foundationRecords!.filter(
      (entry): entry is Extract<TeamRecord, { kind: "gate" }> =>
        entry.kind === "gate" && entry.status === "pending",
    );
    return yield* repo.execute({
      ...commit(
        project,
        project + "-approve-" + state.revision,
        state.revision,
        pending.map((gate) => ({
          ...gate,
          status: "approved" as const,
          revision: gate.revision + 1,
        })),
      ),
      attribution: humanAttribution,
    });
  });
  if (authorized) {
    yield* guided({
      ...(yield* envelope("spec")),
      type: "project-team.specification.propose",
      expectedSpecRevision: 0,
      specification,
      criterionSnapshots: [criterion],
    });
    yield* approve();
    yield* guided({
      ...(yield* envelope("plan")),
      type: "project-team.plan.propose",
      specRevision: 1,
      content: "Deliver and verify the recorded requirement",
      dependencyTaskIds: [],
    });
    const approved = yield* approve();
    const specGate = approved.state.foundationRecords!.find(
      (entry): entry is Extract<TeamRecord, { kind: "gate" }> =>
        entry.kind === "gate" && entry.gate === "specification",
    )!;
    const plan = approved.state.foundationRecords!.find(
      (entry): entry is Extract<TeamRecord, { kind: "plan-revision" }> =>
        entry.kind === "plan-revision",
    )!;
    const planGate = approved.state.foundationRecords!.find(
      (entry): entry is Extract<TeamRecord, { kind: "gate" }> =>
        entry.kind === "gate" && entry.gate === "plan",
    )!;
    yield* guided({
      ...(yield* envelope("execution")),
      type: "project-team.execution.start",
      specRevision: 1,
      planRevision: plan.planRevision,
      specGateId: specGate.recordId,
      expectedSpecGateRevision: specGate.revision,
      planId: plan.recordId,
      expectedPlanRecordRevision: plan.revision,
      planGateId: planGate.recordId,
      expectedPlanGateRevision: planGate.revision,
    });
  } else {
    yield* repo.execute({
      type: "project-work.criterion.upsert",
      projectId,
      taskId,
      commandId: CommandId.make(project + "-criterion"),
      criterion,
      updatedAt: at,
    });
    yield* repo.execute({
      type: "project-work.task.specify",
      projectId,
      taskId,
      commandId: CommandId.make(project + "-spec"),
      specification,
      updatedAt: at,
    });
    yield* repo.execute({
      type: "project-work.task.ready",
      projectId,
      taskId,
      commandId: CommandId.make(project + "-ready"),
      updatedAt: at,
    });
  }
  const role = record(project, "role-revision", project + "-role", {
    status: "available",
    roleId: "implementer",
    roleRevision: 1,
    role: "implementer",
    instructions: "Deliver",
    skills: [],
    tools: [],
    model: "ling",
    memoryAccess: "project",
    delegationDepth: 2,
  });
  const member = record(project, "member", project + "-member", {
    status: "active",
    name: "Worker",
    coordinator: false,
    roleRevisionId: role.recordId,
  });
  const limits = record(project, "limits", project + "-limits", {
    status: "configured",
    environmentModelCalls: 1,
    projectWritableWorkers: 1,
    modelCalls: 1,
    delegationDepth: 2,
    repairAllowance: 2,
    model: "ling",
    tokenLimit: 1000,
    durationLimitMs: 1000,
  });
  const setupState = yield* readCurrentState(sql, projectId);
  const setup = yield* repo.execute(
    commit(project, project + "-setup", setupState.revision, [role, member, limits]),
  );
  const grant = setup.state.foundationRecords!.find(
    (entry): entry is Extract<TeamRecord, { kind: "gate" }> =>
      entry.kind === "gate" && entry.gate === "execution",
  );
  const plan = setup.state.foundationRecords!.find(
    (entry): entry is Extract<TeamRecord, { kind: "plan-revision" }> =>
      entry.kind === "plan-revision",
  );
  const run = record(project, "run-binding", project + "-run", {
    status: authorized ? "reserved" : "running",
    taskId,
    attemptId: project + "-attempt",
    memberId: member.recordId,
    roleRevisionId: role.recordId,
    providerInstanceId: "pi",
    threadId: project + "-thread",
    sessionId: project + "-session",
    environmentId: "environment",
    model: "ling",
    configuration: {
      instructionsHash: "hash",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "0.99.1",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    worktree: "/tmp/" + project,
    branch: project,
    leaseGeneration: 0,
    specRevision: 1,
    planRevision: plan?.planRevision ?? 0,
    ...(grant === undefined
      ? {}
      : {
          authorizationGateId: grant.recordId,
          specificationGateId: setup.state.foundationRecords!.find(
            (entry) => entry.kind === "gate" && entry.gate === "specification",
          )!.recordId,
          planGateId: setup.state.foundationRecords!.find(
            (entry) => entry.kind === "gate" && entry.gate === "plan",
          )!.recordId,
          scopeHash: projectTeamScopeHash(setup.state, taskId, plan),
        }),
  });
  const reservation = record(project, "reservation", project + "-reservation", {
    status: "held",
    environmentId: "environment",
    scope: "environment",
    resourceKey: project + "-different-key",
    slot: 0,
    runId: run.recordId,
    taskId,
    attemptId: project + "-attempt",
    maximumTokens: 1000,
    consumedTokens: 0,
  });
  const effect = record(project, "effect", project + "-effect", {
    status: "pending",
    effectId: project + "-external-effect",
    effectKind: "dispatch",
    taskId,
    runId: run.recordId,
    targetId: run.recordId,
    payload: { recordIds: [run.recordId], expectedRevision: setup.revision + (authorized ? 3 : 0) },
    claimGeneration: 0,
    availableAt: at,
  });
  const command = {
    ...commit(project, project + "-dispatch", setup.revision, [run, reservation, effect]),
    claim: {
      type: "project-work.task.claim" as const,
      commandId: CommandId.make(project + "-dispatch"),
      projectId,
      taskId,
      attemptId: ProjectWorkAttemptId.make(project + "-attempt"),
      leaseToken: "opaque-lease",
      leasedUntil: "2026-01-02T00:00:00.000Z",
      claimedAt: at,
    },
  };
  const claimCommand = {
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make(project + "-dispatch-claim"),
    expectedRevision: setup.revision,
    records: [],
    attribution,
    committedAt: at,
    transition: {
      kind: "claim",
      taskId,
      expectedTaskRevision: setup.state.tasks.find((task) => task.taskId === taskId)!.revision,
      authorizationGateId: grant?.recordId ?? "missing-grant",
      expectedGateRevision: grant?.revision ?? 0,
      binding: run,
      claim: { ...command.claim, commandId: CommandId.make(project + "-dispatch-claim") },
    },
  } satisfies Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
  const running = { ...run, status: "running" as const, revision: 1 };
  const dispatchCommand = commit(project, project + "-dispatch", setup.revision + 3, [
    running,
    reservation,
    effect,
  ]);
  return {
    project,
    command,
    claimCommand,
    dispatchCommand,
    run: authorized ? running : run,
    reservation,
    effect,
    grant,
  };
});

const foundationSnapshot = Effect.fn("foundationSnapshot")(function* (project: string) {
  const sql = yield* SqlClient.SqlClient;
  return {
    state: yield* readCurrentState(sql, ProjectId.make(project)),
    attempts:
      yield* sql`SELECT * FROM project_work_attempts WHERE project_id = ${project} ORDER BY attempt_id`,
    runs: yield* sql`SELECT * FROM project_team_run_binding WHERE project_id = ${project} ORDER BY record_id`,
    reservations:
      yield* sql`SELECT * FROM project_team_reservation WHERE project_id = ${project} ORDER BY record_id`,
    effects:
      yield* sql`SELECT * FROM project_team_effect WHERE project_id = ${project} ORDER BY record_id`,
    gates:
      yield* sql`SELECT * FROM project_team_gate WHERE project_id = ${project} ORDER BY record_id`,
    events:
      yield* sql`SELECT * FROM project_work_events WHERE project_id = ${project} ORDER BY sequence`,
    receipts:
      yield* sql`SELECT * FROM project_work_command_receipts WHERE project_id = ${project} ORDER BY command_id`,
  };
});

const layer = it.layer(Layer.fresh(NodeSqliteClient.layerMemory()));
layer("teams foundation persistence", (it) => {
  it.effect("upgrades old events and invalidates old checkpoints without changing task IDs", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 18 });
      const repo = yield* ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("migration-project");
      yield* repo.execute({
        type: "project-work.task.create",
        projectId: project,
        commandId: CommandId.make("old-create"),
        taskId: ProjectWorkTaskId.make("old-id"),
        title: "Old work",
        createdAt: at,
      });
      yield* sql`UPDATE project_work_reducer_checkpoints SET state_json = '{"projectId":"migration-project","tasks":[],"revision":999}' WHERE project_id = ${project}`;
      const oldTables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'project_team_%'`;
      for (const oldTable of oldTables) yield* sql`DROP TABLE ${sql(oldTable.name)}`;
      yield* runForkMigrations();
      expect(
        (yield* sql`SELECT * FROM project_work_reducer_checkpoints WHERE project_id = ${project}`)
          .length,
      ).toBe(0);
      const next = yield* repo.execute({
        type: "project-work.task.create",
        projectId: project,
        commandId: CommandId.make("new-create"),
        taskId: ProjectWorkTaskId.make("new-id"),
        title: "New work",
        createdAt: at,
      });
      expect(next.state.tasks.map((task) => task.taskId)).toEqual(["old-id", "new-id"]);
      expect(next.revision).toBe(2);
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "preserves canonical issue and cursor identities while accepting display and progress edits",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const project = "identity-project";
        const issue = record(project, "issue", "immutable-issue", {
          status: "open",
          identity: {
            host: "github.com",
            repositoryNodeId: "identity-repo",
            issueNodeId: "identity-issue",
            number: 1,
          },
          repositoryName: "owner/repo",
          title: "Original",
          body: "Original",
          sourceRevision: "one",
          observedAt: at,
        });
        const cursor = record(project, "intake-cursor", "immutable-cursor", {
          status: "ready",
          host: "github.com",
          repositoryNodeId: "identity-repo",
          accountId: "original-account",
          cursor: "page-two",
          etag: "original-etag",
          overlapSince: at,
          lastSuccessfulPageAt: at,
        });
        yield* repo.execute(commit(project, "identity-create", 0, [issue, cursor]));
        for (const [field, value] of Object.entries({
          host: "other.host",
          repositoryNodeId: "other-repo",
          issueNodeId: "other-issue",
          number: 2,
        })) {
          expect(
            (yield* repo
              .execute(
                commit(project, "issue-change-" + field, 2, [
                  { ...issue, revision: 1, identity: { ...issue.identity, [field]: value } },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        for (const [field, value] of Object.entries({
          host: "other.host",
          repositoryNodeId: "other-repo",
          accountId: "other-account",
        })) {
          expect(
            (yield* repo
              .execute(
                commit(project, "cursor-change-" + field, 2, [
                  { ...cursor, revision: 1, [field]: value },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        for (const original of [issue, cursor]) {
          expect(
            (yield* repo
              .execute(
                commit(project, "identity-reinsert-" + original.kind, 2, [
                  { ...original, recordId: original.recordId + "-duplicate" },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const result = yield* repo.execute(
          commit(project, "identity-legitimate-edit", 2, [
            {
              ...issue,
              revision: 1,
              repositoryName: "renamed/repo",
              title: "Edited",
              body: "Edited",
              sourceRevision: "two",
            },
            { ...cursor, revision: 1, generation: 1, cursor: "page-three", etag: "next-etag" },
          ]),
        );
        expect(result.state.foundationRecords).toContainEqual({
          ...issue,
          revision: 1,
          repositoryName: "renamed/repo",
          title: "Edited",
          body: "Edited",
          sourceRevision: "two",
        });
        expect(result.state.foundationRecords).toContainEqual({
          ...cursor,
          revision: 1,
          generation: 1,
          cursor: "page-three",
          etag: "next-etag",
        });
      }).pipe(Effect.provide(services)),
  );

  it.effect("rejects retained authority collisions without overlaying missing replay history", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repo = yield* ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const project = "retained-authority";
      const cursor = record(project, "intake-cursor", "retained-cursor", {
        status: "ready",
        host: "github.com",
        repositoryNodeId: "retained-repo",
        accountId: "retained-account",
        cursor: "page-three",
        etag: "retained-etag",
        overlapSince: at,
      });
      yield* repo.execute(commit(project, "retained-create", 0, [cursor]));
      const retained = { ...cursor, revision: 1, generation: 1 };
      yield* repo.execute(commit(project, "retained-progress", 1, [retained]));
      yield* sql`DELETE FROM project_work_events WHERE project_id = ${project}`;
      yield* sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id = ${project}`;
      expect(
        (yield* repo
          .execute(commit(project, "retained-reset", 0, [{ ...cursor, cursor: "page-one" }]))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* repo.replay(project)).length).toBe(0);
      const rows = yield* sql<{
        revision: number;
        generation: number;
      }>`SELECT revision, generation FROM project_team_intake_cursor WHERE record_id = ${cursor.recordId}`;
      expect(rows).toEqual([{ revision: 1, generation: 1 }]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("keeps immutable roles, one coordinator, bounded pages, receipts and replay", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repo = yield* ProjectWorkRepository;
      const projection = yield* ProjectWorkProjection;
      const query = yield* ProjectWorkQuery;
      const sql = yield* SqlClient.SqlClient;
      const project = "records-project";
      const role = record(project, "role-revision", "role-a", {
        status: "available",
        roleId: "coordinator",
        roleRevision: 1,
        role: "coordinator",
        instructions: "Maintain context",
        skills: [],
        tools: [],
        model: "ling",
        memoryAccess: "project",
        delegationDepth: 2,
      });
      const member = record(project, "member", "member-a", {
        status: "active",
        name: "Coordinator",
        coordinator: true,
        roleRevisionId: role.recordId,
      });
      const command = commit(project, "records-command", 0, [role, member]);
      const first = yield* repo.execute(command);
      let authorized = 0;
      const duplicate = yield* repo.executeAuthorized(command, () => {
        authorized++;
        return Effect.succeed(command);
      });
      expect(duplicate.duplicate).toBe(true);
      expect(authorized).toBe(0);
      expect(duplicate.writeResult).toEqual(first.writeResult);
      const failed = yield* repo
        .execute(commit(project, "coordinator-race", 2, [{ ...member, recordId: "member-b" }]))
        .pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      expect(
        (yield* repo
          .execute(
            commit(project, "role-mutation", 2, [
              { ...role, revision: 1, instructions: "Different" },
            ]),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const page = yield* query.listFoundationRecords({ projectId: project, limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeDefined();
      const second = yield* query.listFoundationRecords({
        projectId: project,
        limit: 1,
        cursor: page.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.recordId).not.toBe(page.items[0]!.recordId);
      expect(second.nextCursor).toBeUndefined();
      const before = yield* projection.state(project);
      yield* projection.rebuild(project);
      expect((yield* projection.state(project)).foundationRecords).toEqual(
        before.foundationRecords,
      );
      // An unversioned but plausible derived checkpoint cannot bypass authoritative replay.
      yield* sql`UPDATE project_work_reducer_checkpoints SET state_json = '{"projectId":"records-project","tasks":[],"attempts":[],"revision":500}' WHERE project_id = ${project}`;
      const newer = yield* repo.execute(
        commit(project, "pause-member", 2, [{ ...member, status: "paused", revision: 1 }]),
      );
      expect(newer.revision).toBe(3);
      expect((yield* repo.replay(project)).length).toBe(3);
    }).pipe(Effect.provide(services)),
  );

  it.effect("uses the same checkpoint version in the fast task-create path", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repo = yield* ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* repo.execute({
        type: "project-work.task.create",
        projectId: ProjectId.make("fast-project"),
        commandId: CommandId.make("fast-create"),
        taskId: ProjectWorkTaskId.make("fast-task"),
        title: "Fast",
        createdAt: at,
      });
      const event = created.events[0]!;
      if (event.type !== "project-work.task.created") throw new Error("Expected task creation");
      yield* sql`DELETE FROM project_work_tasks WHERE project_id = 'fast-project'`;
      yield* sql`DELETE FROM project_work_activity WHERE project_id = 'fast-project'`;
      yield* sql`DELETE FROM project_work_search_fts WHERE project_id = 'fast-project'`;
      const state = applyProjectWorkProjectionEvents(
        emptyProjectWorkProjectionState("fast-project"),
        created.events,
      );
      yield* persistProjectWorkTaskCreated(sql, state, event, 1);
      const checkpoint = yield* sql<{
        version: number;
      }>`SELECT json_extract(state_json, '$.checkpointVersion') AS version FROM project_work_reducer_checkpoints WHERE project_id = 'fast-project'`;
      expect(checkpoint[0]!.version).toBe(PROJECT_WORK_CHECKPOINT_VERSION);
    }).pipe(Effect.provide(services)),
  );
  it.effect("rejects raw claim and run records without exact persisted grant authority", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repo = yield* ProjectWorkRepository;
      const fixture = yield* prepareFoundationProject("raw-dispatch", false);
      const before = yield* foundationSnapshot(fixture.project);
      expect(before.state.foundationRecords!.some((entry) => entry.kind === "gate")).toBe(false);
      expect(before.attempts).toEqual([]);
      expect(before.runs).toEqual([]);
      expect(before.reservations).toEqual([]);
      expect(before.effects).toEqual([]);
      const result = yield* repo.execute(fixture.command).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ProjectWorkPolicyError",
          code: "authority-required",
        },
      });
      expect(yield* foundationSnapshot(fixture.project)).toEqual(before);
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "atomically claims, reserves global capacity and inserts outbox across competing projects",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const sql = yield* SqlClient.SqlClient;
        const projection = yield* ProjectWorkProjection;
        const query = yield* ProjectWorkQuery;
        const a = yield* prepareFoundationProject("capacity-a");
        const b = yield* prepareFoundationProject("capacity-b");
        const beforeA = yield* foundationSnapshot(a.project);
        const beforeB = yield* foundationSnapshot(b.project);
        const outcomes = yield* Effect.all(
          [
            repo
              .executeAtomic(Effect.succeed([a.claimCommand, a.dispatchCommand]))
              .pipe(Effect.result),
            repo
              .executeAtomic(Effect.succeed([b.claimCommand, b.dispatchCommand]))
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
        const winner = outcomes[0]!._tag === "Success" ? a : b;
        const loser = winner === a ? b : a;
        expect(outcomes[winner === a ? 1 : 0]).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PersistenceSqlError" },
        });
        expect(yield* foundationSnapshot(loser.project)).toEqual(loser === a ? beforeA : beforeB);
        const accepted = yield* foundationSnapshot(winner.project);
        expect(accepted.attempts).toHaveLength(1);
        expect(accepted.runs).toHaveLength(1);
        expect(accepted.state.foundationRecords).toContainEqual(winner.run);
        expect(accepted.state.foundationRecords).toContainEqual({
          ...winner.grant!,
          status: "consumed",
          revision: winner.grant!.revision + 1,
          consumedByRunId: winner.run.recordId,
          consumedByCommandId: winner.claimCommand.commandId,
        });
        expect(
          accepted.events.filter(
            (event) =>
              event.command_id === winner.claimCommand.commandId ||
              event.command_id === winner.dispatchCommand.commandId,
          ),
        ).toHaveLength(6);
        expect(
          accepted.receipts.filter(
            (receipt) =>
              receipt.command_id === winner.claimCommand.commandId ||
              receipt.command_id === winner.dispatchCommand.commandId,
          ),
        ).toHaveLength(2);
        const revision = accepted.state.revision;
        expect(
          (yield* sql`SELECT * FROM project_team_reservation WHERE status = 'held'`).length,
        ).toBe(1);
        expect(
          (yield* sql`SELECT * FROM project_team_effect WHERE project_id IN ('capacity-a','capacity-b')`)
            .length,
        ).toBe(1);
        expect(
          (yield* sql`SELECT * FROM project_work_attempts WHERE project_id = ${loser.project}`)
            .length,
        ).toBe(0);
        expect(
          (yield* sql`SELECT * FROM project_work_events WHERE project_id = ${loser.project} AND command_id = ${loser.command.commandId}`)
            .length,
        ).toBe(0);
        expect(
          (yield* sql`SELECT * FROM project_work_command_receipts WHERE project_id = ${loser.project} AND command_id = ${loser.command.commandId}`)
            .length,
        ).toBe(0);
        const bound = yield* query.getRunBindingForSession({
          providerInstanceId: "pi",
          threadId: winner.project + "-thread",
          sessionId: winner.project + "-session",
        });
        expect(bound._tag).toBe("Some");
        expect(
          (yield* query.getRunBindingForSession({
            providerInstanceId: "pi",
            threadId: winner.project + "-thread",
            sessionId: "forged",
          }))._tag,
        ).toBe("None");
        yield* sql`UPDATE project_team_run_binding SET generation = 1 WHERE record_id = ${winner.run.recordId}`;
        expect(
          (yield* query.getRunBindingForSession({
            providerInstanceId: "pi",
            threadId: winner.project + "-thread",
            sessionId: winner.project + "-session",
          }))._tag,
        ).toBe("None");
        yield* sql`UPDATE project_team_run_binding SET generation = 0 WHERE record_id = ${winner.run.recordId}`;
        expect(
          (yield* repo
            .execute(
              commit(winner.project, "mutate-frozen-model", revision, [
                { ...winner.run, revision: 2, model: "paid-fallback" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* repo.execute(
          commit(winner.project, "dispatch-receipt", revision, [
            {
              ...winner.effect,
              revision: 1,
              status: "succeeded",
              outcome: "owned process acknowledged",
            },
          ]),
        );
        expect(
          (yield* repo
            .execute(
              commit(winner.project, "retry-completed-effect", revision + 1, [
                { ...winner.effect, revision: 2 },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const before =
          yield* sql`SELECT * FROM project_team_effect WHERE project_id = ${winner.project}`;
        yield* projection.rebuild(winner.project);
        expect(
          yield* sql`SELECT * FROM project_team_effect WHERE project_id = ${winner.project}`,
        ).toEqual(before);
        expect(
          (yield* sql`SELECT * FROM project_team_reservation WHERE status = 'held'`).length,
        ).toBe(1);
        // Force a late failure after authority inserts; all domain/receipt writes roll back.
        yield* repo.execute(
          commit(winner.project, winner.project + "-release", revision + 1, [
            { ...winner.reservation, status: "released", revision: 1 },
          ]),
        );
        yield* sql`CREATE TRIGGER foundation_forced_rollback BEFORE INSERT ON project_work_command_receipts WHEN NEW.command_id = 'capacity-forced-rollback' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`;
        const beforeForced = yield* foundationSnapshot(loser.project);
        const forcedClaimId = CommandId.make("capacity-forced-rollback-claim");
        const forcedClaim = {
          ...loser.claimCommand,
          commandId: forcedClaimId,
          transition: {
            ...loser.claimCommand.transition!,
            claim: { ...loser.claimCommand.transition!.claim, commandId: forcedClaimId },
          },
        };
        const forcedDispatch = {
          ...loser.dispatchCommand,
          commandId: CommandId.make("capacity-forced-rollback"),
        };
        const forced = yield* repo
          .executeAtomic(Effect.succeed([forcedClaim, forcedDispatch]))
          .pipe(Effect.result);
        expect(forced).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PersistenceSqlError",
          },
        });
        expect(yield* foundationSnapshot(loser.project)).toEqual(beforeForced);
        expect(
          (yield* sql`SELECT * FROM project_team_effect WHERE project_id = ${loser.project}`)
            .length,
        ).toBe(0);
        expect(
          (yield* sql`SELECT * FROM project_team_reservation WHERE project_id = ${loser.project}`)
            .length,
        ).toBe(0);
        expect(
          (yield* sql`SELECT * FROM project_work_attempts WHERE project_id = ${loser.project}`)
            .length,
        ).toBe(0);
        yield* sql`DROP TRIGGER foundation_forced_rollback`;
        const retried = yield* repo.executeAtomic(Effect.succeed([forcedClaim, forcedDispatch]));
        expect(retried).toHaveLength(2);
        const afterRetry = yield* foundationSnapshot(loser.project);
        expect(afterRetry.attempts).toHaveLength(1);
        expect(afterRetry.runs).toHaveLength(1);
        expect(afterRetry.reservations).toHaveLength(1);
        expect(afterRetry.effects).toHaveLength(1);
        expect(afterRetry.state.foundationRecords).toContainEqual({
          ...loser.grant!,
          status: "consumed",
          revision: loser.grant!.revision + 1,
          consumedByRunId: loser.run.recordId,
          consumedByCommandId: forcedClaimId,
        });
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "freezes effect identity and semantic payload and retains uncertainty across replay",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const projection = yield* ProjectWorkProjection;
        const query = yield* ProjectWorkQuery;
        const sql = yield* SqlClient.SqlClient;
        const project = "immutable-effects";
        const taskId = ProjectWorkTaskId.make("immutable-effects-task");
        yield* repo.execute({
          type: "project-work.task.create",
          projectId: ProjectId.make(project),
          taskId,
          commandId: CommandId.make("immutable-effects-create-task"),
          title: "Publication target",
          createdAt: at,
        });
        const request: ProjectWorkPublicationRequest = {
          version: 1,
          kind: "create-pr",
          operationId: "immutable-effect",
          marker: "immutable_effect_marker",
          repository: { host: "github.com", nodeId: "repo-node", nameWithOwner: "owner/repo" },
          target: {
            projectId: ProjectId.make(project),
            taskId,
            specRevision: 0,
            planRevision: 0,
            scopeHash: "original-scope",
            baseSha: "original-base",
            headSha: "original-head",
            baseRef: "main",
            headRef: "task",
            headRepositoryNodeId: "repo-node",
            headSelector: "owner:task",
          },
          expectedTaskRevision: 0,
          authorizationRecordIds: ["original-review"],
          title: "Once",
          body: "Original publication request",
        };
        const effect = record(project, "effect", "immutable-effect", {
          taskId,
          status: "pending",
          effectId: request.operationId,
          effectKind: "publication",
          targetId: "github.com/owner/repo",
          payload: {
            recordIds: request.authorizationRecordIds,
            expectedRevision: request.expectedTaskRevision,
            summary: canonicalProjectWorkPayload(request),
          },
          claimGeneration: 0,
          availableAt: at,
        });
        yield* repo.execute(commit(project, "effect-create", 1, [effect]));
        for (const [i, change] of [
          { effectId: "renamed" },
          { targetId: "other" },
          { effectKind: "setup" },
          { payload: { ...effect.payload, summary: "Different" } },
        ].entries()) {
          expect(
            (yield* repo
              .execute(
                commit(project, "effect-mutate-" + i, 2, [
                  yield* decodeTeamRecordEffect({ ...effect, revision: 1, ...change }),
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const rawStatus = yield* repo
          .execute(
            commit(project, "effect-raw-uncertain", 2, [
              { ...effect, revision: 1, status: "uncertain" },
            ]),
          )
          .pipe(Effect.result);
        expect(rawStatus).toMatchObject({
          _tag: "Failure",
          failure: { message: "Publication status requires a typed private transition" },
        });
        const publicationAttribution = {
          actor: { kind: "system", id: "project-work-github-outbox" },
          source: { kind: "system", id: "project-work-github-outbox" },
          recordedAt: at,
        } as const;
        yield* repo.execute({
          type: "project-work.foundation.commit",
          projectId: ProjectId.make(project),
          commandId: CommandId.make("effect-claim"),
          expectedRevision: 2,
          records: [],
          committedAt: at,
          attribution: publicationAttribution,
          transition: {
            kind: "publication.claim",
            effectId: effect.effectId,
            expectedEffectRevision: 0,
            expectedClaimGeneration: 0,
          },
        });
        const receipt: ProjectWorkPublicationOutcome = {
          version: 1,
          kind: "uncertain",
          operationId: effect.effectId,
          requestHash: NodeCrypto.createHash("sha256")
            .update(effect.payload.summary!)
            .digest("hex"),
          claimGeneration: 1,
          observedAt: at,
          reason: "missing-match",
        };
        yield* repo.execute({
          type: "project-work.foundation.commit",
          projectId: ProjectId.make(project),
          commandId: CommandId.make("effect-uncertain"),
          expectedRevision: 3,
          records: [],
          committedAt: at,
          attribution: publicationAttribution,
          transition: {
            kind: "publication.reflect",
            effectId: effect.effectId,
            expectedEffectRevision: 1,
            claimGeneration: 1,
            receipt,
          },
        });
        const uncertain = {
          ...effect,
          revision: 2,
          status: "uncertain" as const,
          claimGeneration: 1,
          outcome: canonicalProjectWorkPayload(receipt),
        };
        const historicalEvents = yield* repo.replay(project);
        const retainedReceipts =
          yield* sql`SELECT * FROM project_work_command_receipts WHERE project_id=${project}`;
        yield* projection.rebuild(project);
        expect(yield* repo.replay(project)).toEqual(historicalEvents);
        for (const status of ["failed", "pending", "claimed", "succeeded"] as const) {
          expect(
            (yield* repo
              .execute(
                commit(project, "escape-uncertain-" + status, 4, [
                  { ...uncertain, revision: 3, status, outcome: "untyped claim of reconciliation" },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          (yield* repo
            .execute(
              commit(project, "duplicate-original-effect", 4, [
                { ...effect, recordId: "another-effect" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* query.listFoundationRecords({ projectId: project })).items).toEqual([
          uncertain,
        ]);
        expect(yield* repo.replay(project)).toEqual(historicalEvents);
        expect(
          yield* sql`SELECT * FROM project_work_command_receipts WHERE project_id=${project}`,
        ).toEqual(retainedReceipts);
      }).pipe(Effect.provide(services)),
  );

  it.effect("reopens immutable memory payloads and checks the complete source tuple", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-foundation-memory-" });
        const database = () =>
          services.pipe(
            Layer.provideMerge(
              Layer.fresh(
                NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }),
              ),
            ),
          );
        const project = "reopened-memory";
        const source = record(project, "memory-source", "reopen-source", {
          status: "current",
          sourceKind: "finding",
          sourceId: "artifact",
          sourceRevision: 1,
          content: "Original",
          contentHash: "same-hash",
          attribution,
          sharedWithProjectIds: [],
        });
        const other = { ...source, recordId: "reopen-other", sourceId: "other-artifact" };
        const extraction = record(project, "memory-extraction", "reopen-extraction", {
          status: "extracted",
          engine: "mem0",
          engineVersion: "2.2.1",
          sourceId: source.recordId,
          sourceRevision: 1,
          sourceGeneration: 0,
          extractionModel: "ling",
          embeddingModel: "nvidia",
          embeddingDimensions: 2048,
          expectedObservationIds: ["reopen-observation"],
          completedObservationIds: [],
          extractionHash: "frozen-hash",
        });
        const observation = record(project, "memory-observation", "reopen-observation", {
          status: "current",
          sourceId: source.recordId,
          sourceRevision: 1,
          sourceGeneration: 0,
          extractionId: extraction.recordId,
          observationKey: "one",
          body: "Original fact",
          provenance: attribution,
        });
        const indexed = {
          ...extraction,
          revision: 1,
          status: "indexed" as const,
          completedObservationIds: [observation.recordId],
        };
        // A matching UUID/revision/generation from a different source cannot prove completion.
        expect(() =>
          validateProjectTeamRecord(
            {
              ...emptyProjectWorkReducerState(project),
              foundationRecords: [source, other, { ...observation, sourceId: other.recordId }],
            },
            { ...indexed, revision: 0 },
            attribution,
          ),
        ).toThrow();
        yield* Effect.gen(function* () {
          yield* runMigrations();
          const repo = yield* ProjectWorkRepository;
          yield* repo.execute(
            commit(project, "reopen-initial", 0, [source, other, extraction, observation]),
          );
          yield* repo.execute(commit(project, "reopen-index", 4, [indexed]));
        }).pipe(Effect.provide(database()));
        yield* Effect.gen(function* () {
          const repo = yield* ProjectWorkRepository;
          const projection = yield* ProjectWorkProjection;
          for (const [i, change] of [
            { sourceId: other.recordId },
            { extractionModel: "changed" },
          ].entries())
            expect(
              (yield* repo
                .execute(
                  commit(project, "reopen-retarget-" + i, 5, [
                    yield* decodeTeamRecordEffect({ ...indexed, revision: 2, ...change }),
                  ]),
                )
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
          expect(
            (yield* repo
              .execute(
                commit(project, "reopen-mutate-body", 5, [
                  { ...observation, revision: 1, body: "Changed" },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* projection.rebuild(project);
          expect(
            (yield* projection.state(project)).foundationRecords?.find(
              (entry) => entry.recordId === observation.recordId,
            ),
          ).toEqual(observation);
          const corrected = {
            ...source,
            revision: 1,
            generation: 1,
            content: "Corrected",
            attribution: { ...attribution, actor: { kind: "human" as const, id: "corrector" } },
          };
          yield* repo.execute(commit(project, "reopen-correction", 5, [corrected]));
          expect(
            (yield* repo
              .execute(
                commit(project, "reopen-stale-extraction", 6, [
                  { ...extraction, recordId: "late-extraction" },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* projection.rebuild(project);
          expect(
            (yield* projection.state(project)).foundationRecords?.find(
              (entry) => entry.recordId === source.recordId,
            ),
          ).toEqual(corrected);
        }).pipe(Effect.provide(database()));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("rejects global record collisions without committing divergent events", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repo = yield* ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const mission = record("collision-a", "mission", "global-mission", {
        status: "draft",
        title: "A",
        objective: "A",
        requiredTaskIds: [],
      });
      yield* repo.execute(commit("collision-a", "collision-first", 0, [mission]));
      expect(
        (yield* repo
          .execute(
            commit("collision-b", "collision-second", 0, [
              { ...mission, projectId: ProjectId.make("collision-b") },
            ]),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const differentKind = record("collision-b", "role-revision", "global-mission", {
        status: "available",
        roleId: "reviewer",
        roleRevision: 0,
        role: "reviewer",
        instructions: "Review",
        skills: [],
        tools: [],
        model: "ling",
        memoryAccess: "none",
        delegationDepth: 0,
      });
      expect(
        (yield* repo
          .execute(commit("collision-b", "cross-kind-collision", 0, [differentKind]))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* sql`SELECT * FROM project_work_events WHERE project_id = 'collision-b'`).length,
      ).toBe(0);
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "retains sourced extraction manifests, rejects incomplete/duplicate sets and fences tombstones",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const projection = yield* ProjectWorkProjection;
        const sql = yield* SqlClient.SqlClient;
        const project = "memory-project";
        const source = record(project, "memory-source", "memory-source", {
          status: "current",
          sourceKind: "finding",
          sourceId: "original-artifact",
          sourceRevision: 1,
          content: "Sourced observation",
          contentHash: "hash-1",
          attribution,
          sharedWithProjectIds: [],
        });
        const extraction = record(project, "memory-extraction", "memory-extraction", {
          status: "extracted",
          engine: "mem0",
          engineVersion: "2.2.1",
          sourceId: source.recordId,
          sourceRevision: 1,
          sourceGeneration: 0,
          extractionModel: "commandcode/ling",
          embeddingModel: "openrouter/nvidia",
          embeddingDimensions: 2048,
          expectedObservationIds: ["observation-a", "observation-b"],
          completedObservationIds: [],
          extractionHash: "extraction-hash",
        });
        yield* repo.execute(commit(project, "memory-source-commit", 0, [source, extraction]));
        const { extractionHash: _extractionHash, ...unfrozenExtraction } = extraction;
        const invalid = [
          {
            ...extraction,
            revision: 1,
            status: "indexed",
            completedObservationIds: ["observation-a", "observation-a"],
          },
          {
            ...extraction,
            revision: 1,
            status: "indexed",
            completedObservationIds: ["observation-a"],
          },
          {
            ...extraction,
            revision: 1,
            status: "indexed",
            expectedObservationIds: [],
            completedObservationIds: [],
          },
          { ...extraction, revision: 1, expectedObservationIds: ["other"] },
          { ...unfrozenExtraction, recordId: "unfrozen-extraction", revision: 0 },
          { ...extraction, recordId: "implicit-empty", revision: 0, expectedObservationIds: [] },
        ];
        for (const [i, bad] of invalid.entries())
          expect(
            (yield* repo
              .execute(
                commit(project, "invalid-manifest-" + i, 2, [yield* decodeTeamRecordEffect(bad)]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect(
          (yield* repo
            .execute(
              commit(project, "unfenced-source-revision", 2, [
                { ...source, revision: 1, sourceRevision: 2 },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const observation = record(project, "memory-observation", "observation-a", {
          status: "current",
          sourceId: source.recordId,
          sourceRevision: 1,
          sourceGeneration: 0,
          extractionId: extraction.recordId,
          observationKey: "first",
          body: "Sourced observation",
          provenance: attribution,
        });
        yield* repo.execute(commit(project, "memory-observation", 2, [observation]));
        expect(
          (yield* repo
            .execute(
              commit(project, "duplicate-source-observation", 3, [
                { ...observation, recordId: "observation-b" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const indexed = yield* decodeTeamRecordEffect({
          ...extraction,
          revision: 1,
          status: "indexed",
          completedObservationIds: ["observation-b", "observation-a"],
        });
        const secondObservation = {
          ...observation,
          recordId: "observation-b",
          observationKey: "second",
        };
        yield* repo.execute(commit(project, "complete-manifest", 3, [secondObservation, indexed]));
        for (const [i, change] of [
          { sourceId: "other-source" },
          { sourceRevision: 2 },
          { sourceGeneration: 1 },
          { extractionModel: "different" },
          { embeddingModel: "different" },
          { extractionHash: "different" },
          { expectedObservationIds: ["different"] },
        ].entries()) {
          expect(
            (yield* repo
              .execute(
                commit(project, "mutate-extraction-" + i, 5, [
                  yield* decodeTeamRecordEffect({ ...indexed, revision: 2, ...change }),
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        for (const [i, change] of [
          { body: "Changed original UUID" },
          { provenance: { ...attribution, actor: { kind: "human", id: "other" } } },
          { observationKey: "different" },
        ].entries()) {
          expect(
            (yield* repo
              .execute(
                commit(project, "mutate-observation-" + i, 5, [
                  yield* decodeTeamRecordEffect({ ...observation, revision: 1, ...change }),
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        for (const [i, change] of [
          { content: "Different content with same caller hash" },
          { attribution: { ...attribution, actor: { kind: "human", id: "other" } } },
          { sourceKind: "decision" },
        ].entries()) {
          expect(
            (yield* repo
              .execute(
                commit(project, "unfenced-source-payload-" + i, 5, [
                  yield* decodeTeamRecordEffect({ ...source, revision: 1, ...change }),
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        yield* projection.rebuild(project);
        expect(
          (yield* projection.state(project)).foundationRecords?.find(
            (entry) => entry.recordId === observation.recordId,
          ),
        ).toEqual(observation);
        const tombstone = yield* decodeTeamRecordEffect({
          ...source,
          revision: 1,
          generation: 1,
          status: "retracted",
          tombstonedAt: at,
        });
        yield* repo.execute(commit(project, "memory-delete", 5, [tombstone]));
        expect(
          (yield* repo
            .execute(
              commit(project, "delayed-extraction", 6, [
                { ...extraction, recordId: "late-extraction" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* repo
            .execute(
              commit(project, "resurrect-source", 6, [{ ...source, revision: 2, generation: 1 }]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* projection.rebuild(project);
        const row = yield* sql<{
          status: string;
          generation: number;
        }>`SELECT status, generation FROM project_team_memory_source WHERE record_id = 'memory-source'`;
        expect(row[0]).toEqual({ status: "retracted", generation: 1 });
        expect((yield* repo.replay(project)).length).toBe(6);
        // Empty extraction is an explicit outcome, never a fabricated indexed set.
        const freshSource = { ...source, recordId: "empty-source" };
        const noFacts = yield* decodeTeamRecordEffect({
          ...extraction,
          recordId: "empty-extraction",
          sourceId: "empty-source",
          status: "no-facts",
          expectedObservationIds: [],
          completedObservationIds: [],
        });
        yield* repo.execute(commit(project, "no-facts", 6, [freshSource, noFacts]));
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "persists pending questions and distinct mailbox receipt states across restart/replay",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const projection = yield* ProjectWorkProjection;
        const sql = yield* SqlClient.SqlClient;
        const project = "mailbox-project";
        const taskId = ProjectWorkTaskId.make("mailbox-task");
        yield* repo.execute({
          type: "project-work.task.create",
          projectId: ProjectId.make(project),
          taskId,
          commandId: CommandId.make("mailbox-create"),
          title: "Clarify",
          createdAt: at,
        });
        const role = record(project, "role-revision", "mailbox-role", {
          status: "available",
          roleId: "coordinator",
          roleRevision: 1,
          role: "coordinator",
          instructions: "Ask",
          skills: [],
          tools: [],
          model: "ling",
          memoryAccess: "project",
          delegationDepth: 2,
        });
        const sender = record(project, "member", "mailbox-sender", {
          status: "active",
          name: "Coordinator",
          coordinator: true,
          roleRevisionId: role.recordId,
        });
        const recipient = record(project, "member", "mailbox-recipient", {
          status: "active",
          name: "Worker",
          coordinator: false,
          roleRevisionId: role.recordId,
        });
        const pending = record(project, "gate", "pending-plan", {
          status: "pending",
          taskId,
          gate: "plan",
          specRevision: 0,
          planRevision: 0,
          contentHash: "exact-payload",
          attribution,
          evidenceIds: [],
        });
        const question = record(project, "question", "human-question", {
          status: "pending",
          taskId,
          senderId: sender.recordId,
          targetGateId: pending.recordId,
          targetRevision: 0,
          body: "Which scope?",
          choices: ["A", "B"],
        });
        const message = record(project, "message", "mailbox-message", {
          status: "queued",
          commandId: "stable-message-command",
          senderId: sender.recordId,
          recipientId: recipient.recordId,
          taskId,
          body: "Finding",
          evidenceIds: [],
          deliveryGeneration: 0,
          deliveryCursor: 0,
        });
        const repair = record(project, "repair-episode", "repair-episode", {
          status: "active",
          taskId,
          failureFingerprint: "same-failure",
          relevantRevision: "tree",
          allowance: 2,
          semanticRepairs: 1,
          transportRetries: 0,
          timeoutCount: 0,
          attemptIds: [],
        });
        yield* repo.execute(
          commit(project, "mailbox-initial", 1, [
            role,
            sender,
            recipient,
            pending,
            question,
            message,
            repair,
          ]),
        );
        // Agent/system may ask for approval; it cannot create the approval itself.
        expect(
          (yield* repo
            .execute(
              commit(project, "forged-approval", 8, [
                { ...pending, status: "approved", revision: 1 },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        for (const status of ["approved", "rejected", "consumed"] as const) {
          const forgedGate = {
            ...pending,
            status,
            revision: 1,
            attribution: { ...attribution, actor: { kind: "human" as const, id: "user" } },
          };
          expect(
            (yield* repo
              .execute(commit(project, "forged-gate-" + status, 8, [forgedGate]))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          (yield* repo
            .execute(
              commit(project, "duplicate-message-command", 8, [
                { ...message, recordId: "duplicate-mailbox-message" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* repo
            .execute(
              commit(project, "reset-repairs", 8, [{ ...repair, revision: 1, semanticRepairs: 0 }]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* repo.execute(
          commit(project, "message-delivered", 8, [
            { ...message, revision: 1, status: "delivered", deliveryCursor: 1 },
          ]),
        );
        for (const [i, change] of [
          { commandId: "renamed" },
          { recipientId: sender.recordId },
          { body: "Different" },
          { evidenceIds: ["different"] },
        ].entries()) {
          expect(
            (yield* repo
              .execute(
                commit(project, "mutate-message-" + i, 9, [
                  yield* decodeTeamRecordEffect({
                    ...message,
                    status: "delivered",
                    revision: 2,
                    ...change,
                  }),
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        yield* repo.execute(
          commit(project, "question-seen", 9, [{ ...question, revision: 1, seenAt: at }]),
        );
        const seen = (yield* projection.state(project)).foundationRecords?.find(
          (entry) => entry.recordId === question.recordId,
        );
        expect(seen?.status).toBe("pending");
        const answer = yield* decodeTeamRecordEffect({
          ...question,
          revision: 2,
          seenAt: at,
          status: "answered",
          answer: "A",
          answeredBy: { ...attribution, actor: { kind: "human", id: "user" } },
        });
        expect(
          (yield* repo
            .execute(commit(project, "forged-human-answer", 10, [answer]))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const answerCommand = {
          ...commit(project, "question-answer-device-a", 10, [answer]),
          attribution: { ...attribution, actor: { kind: "human" as const, id: "user" } },
        };
        yield* repo.execute(answerCommand);
        expect((yield* repo.execute(answerCommand)).duplicate).toBe(true);
        expect(
          (yield* repo
            .execute(commit(project, "question-answer-device-b", 10, [answer]))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id = ${project}`;
        yield* projection.rebuild(project);
        const restored = (yield* projection.state(project)).foundationRecords;
        expect(restored?.find((entry) => entry.recordId === question.recordId)?.status).toBe(
          "answered",
        );
        expect(restored?.find((entry) => entry.recordId === message.recordId)?.status).toBe(
          "delivered",
        );
        expect((yield* repo.replay(project)).length).toBe(11);
        yield* repo.execute(
          commit(project, "message-acknowledged", 11, [
            {
              ...message,
              revision: 2,
              status: "acknowledged",
              deliveryCursor: 1,
              acknowledgedAt: at,
            },
          ]),
        );
        yield* repo.execute(
          commit(project, "message-resolved", 12, [
            {
              ...message,
              revision: 3,
              status: "resolved",
              deliveryCursor: 1,
              acknowledgedAt: at,
              resolvedAt: at,
            },
          ]),
        );
        yield* projection.rebuild(project);
        expect(
          (yield* projection.state(project)).foundationRecords?.find(
            (entry) => entry.recordId === message.recordId,
          )?.status,
        ).toBe("resolved");
      }).pipe(Effect.provide(services)),
  );
});
