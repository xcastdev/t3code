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
  type ProjectTeamRecord as TeamRecord,
} from "@t3tools/contracts";
import { runMigrations, runForkMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
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
  it.effect(
    "atomically claims, reserves global capacity and inserts outbox across competing projects",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const sql = yield* SqlClient.SqlClient;
        const projection = yield* ProjectWorkProjection;
        const query = yield* ProjectWorkQuery;
        const prepare = Effect.fn("prepareFoundationProject")(function* (project: string) {
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
          yield* repo.execute({
            type: "project-work.criterion.upsert",
            projectId,
            taskId,
            commandId: CommandId.make(project + "-criterion"),
            criterion: {
              criterionId,
              taskId,
              description: "Recorded requirement",
              required: false,
              status: "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: at,
            },
            updatedAt: at,
          });
          yield* repo.execute({
            type: "project-work.task.specify",
            projectId,
            taskId,
            commandId: CommandId.make(project + "-spec"),
            specification: {
              objective: "Deliver",
              scopeIn: "Task",
              scopeOut: "Unrelated work",
              criterionIds: [criterionId],
              revision: 1,
              protected: false,
            },
            updatedAt: at,
          });
          yield* repo.execute({
            type: "project-work.task.ready",
            projectId,
            taskId,
            commandId: CommandId.make(project + "-ready"),
            updatedAt: at,
          });
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
          yield* repo.execute(commit(project, project + "-setup", 4, [role, member, limits]));
          const run = record(project, "run-binding", project + "-run", {
            status: "running",
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
            planRevision: 0,
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
            payload: { recordIds: [run.recordId], expectedRevision: 7 },
            claimGeneration: 0,
            availableAt: at,
          });
          const command = {
            ...commit(project, project + "-dispatch", 7, [run, reservation, effect]),
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
          return { project, command, run, reservation, effect };
        });
        const a = yield* prepare("capacity-a");
        const b = yield* prepare("capacity-b");
        const outcomes = yield* Effect.all(
          [
            repo.execute(a.command).pipe(Effect.result),
            repo.execute(b.command).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
        const winner = outcomes[0]!._tag === "Success" ? a : b;
        const loser = winner === a ? b : a;
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
              commit(winner.project, "mutate-frozen-model", 11, [
                { ...winner.run, revision: 1, model: "paid-fallback" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* repo.execute(
          commit(winner.project, "dispatch-receipt", 11, [
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
              commit(winner.project, "retry-completed-effect", 12, [
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
          commit(winner.project, winner.project + "-release", 12, [
            { ...winner.reservation, status: "released", revision: 1 },
          ]),
        );
        yield* sql`CREATE TRIGGER foundation_forced_rollback BEFORE INSERT ON project_work_command_receipts WHEN NEW.command_id = 'capacity-forced-rollback' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`;
        const forced = {
          ...loser.command,
          commandId: CommandId.make("capacity-forced-rollback"),
          claim: { ...loser.command.claim, commandId: CommandId.make("capacity-forced-rollback") },
        };
        expect((yield* repo.execute(forced).pipe(Effect.result))._tag).toBe("Failure");
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
        const project = "immutable-effects";
        const effect = record(project, "effect", "immutable-effect", {
          status: "pending",
          effectId: "external-once",
          effectKind: "publication",
          targetId: "issue",
          payload: { recordIds: [], expectedRevision: 0, summary: "Once" },
          claimGeneration: 0,
          availableAt: at,
        });
        yield* repo.execute(commit(project, "effect-create", 0, [effect]));
        for (const [i, change] of [
          { effectId: "renamed" },
          { targetId: "other" },
          { effectKind: "setup" },
          { payload: { ...effect.payload, summary: "Different" } },
        ].entries()) {
          expect(
            (yield* repo
              .execute(
                commit(project, "effect-mutate-" + i, 1, [
                  yield* decodeTeamRecordEffect({ ...effect, revision: 1, ...change }),
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const uncertain = { ...effect, revision: 1, status: "uncertain" as const };
        yield* repo.execute(commit(project, "effect-uncertain", 1, [uncertain]));
        yield* projection.rebuild(project);
        for (const status of ["failed", "pending", "claimed", "succeeded"] as const) {
          expect(
            (yield* repo
              .execute(
                commit(project, "escape-uncertain-" + status, 2, [
                  { ...uncertain, revision: 2, status, outcome: "untyped claim of reconciliation" },
                ]),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          (yield* repo
            .execute(
              commit(project, "duplicate-original-effect", 2, [
                { ...effect, recordId: "another-effect" },
              ]),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* query.listFoundationRecords({ projectId: project })).items).toEqual([
          uncertain,
        ]);
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
