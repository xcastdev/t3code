import {
  ProviderInstanceId,
  ThreadId,
  EnvironmentId,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import {
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkAttemptId,
  ProjectWorkKnowledgeId,
  ProjectWorkDecisionId,
  ProjectWorkCommentId,
  ProjectWorkRelationshipId,
  CommandId,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkSearch, ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";
import { applyProjectWorkEvents, emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";

const projectId = ProjectId.make("project-repository");
const taskId = ProjectWorkTaskId.make("task-repository-append");
const at = "2026-01-01T00:00:00.000Z";

const layer = it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layerMemory())));

layer("ProjectWorkRepository", (it) => {
  it.effect("rejects managed review completion without persisting report events or receipts", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runForkMigrations();
      const repository = yield* ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const p = ProjectId.make("review-completion-sql");
      const parentId = ProjectWorkTaskId.make("review-parent-sql");
      const human = {
        actor: { kind: "human" as const, id: "maintainer" },
        source: { kind: "web" as const, id: "review-sql-client" },
        recordedAt: at,
      };
      const load = Effect.fn("reviewCompletionFixture.load")(function* () {
        return applyProjectWorkEvents(emptyProjectWorkReducerState(p), yield* repository.replay(p));
      });
      const guided = Effect.fn("reviewCompletionFixture.guided")(function* (
        intent: ProjectTeamGuidedIntent,
      ) {
        return yield* repository.execute({
          type: "project-work.foundation.commit",
          projectId: p,
          commandId: intent.commandId,
          expectedRevision: intent.expectedRevision,
          attribution: human,
          records: [],
          committedAt: at,
          guided: { intent },
        });
      });
      const approve = Effect.fn("reviewCompletionFixture.approve")(function* () {
        const state = yield* load();
        const records = state
          .foundationRecords!.filter(
            (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
              r.kind === "gate" && r.status === "pending",
          )
          .map((r) => ({ ...r, revision: r.revision + 1, status: "approved" as const }));
        yield* repository.execute({
          type: "project-work.foundation.commit",
          projectId: p,
          commandId: CommandId.make(`review-approve-${state.revision}`),
          expectedRevision: state.revision,
          attribution: human,
          records,
          committedAt: at,
        });
      });
      yield* repository.execute({
        type: "project-work.task.create",
        projectId: p,
        taskId: parentId,
        commandId: CommandId.make("review-parent-capture"),
        title: "Review parent",
        createdAt: at,
        attribution: human,
      });
      let state = yield* load();
      yield* guided({
        type: "project-team.specification.propose",
        projectId: p,
        taskId: parentId,
        commandId: CommandId.make("review-parent-spec"),
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        expectedSpecRevision: 0,
        specification: {
          objective: "Bounded reviewed work",
          scopeIn: "One behavior",
          scopeOut: "Other behaviors",
          criterionIds: [ProjectWorkCriterionId.make("review-parent-criterion")],
          revision: 1,
          protected: false,
        },
        criterionSnapshots: [
          {
            criterionId: ProjectWorkCriterionId.make("review-parent-criterion"),
            taskId: parentId,
            description: "Verify the parent behavior",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
        ],
      });
      yield* approve();
      state = yield* load();
      yield* guided({
        type: "project-team.plan.propose",
        projectId: p,
        taskId: parentId,
        commandId: CommandId.make("review-parent-plan"),
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: 1,
        content: "Bounded implementation and validation",
        dependencyTaskIds: [],
      });
      yield* approve();
      state = yield* load();
      const spec = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
          r.kind === "gate" && r.gate === "specification",
      )!;
      const plan = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
          r.kind === "plan-revision",
      )!;
      const planGate = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
          r.kind === "gate" && r.gate === "plan",
      )!;
      yield* guided({
        type: "project-team.assignment.start",
        projectId: p,
        taskId: parentId,
        commandId: CommandId.make("review-child-assignment"),
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        assignmentKind: "review",
        objective: "Review the exact approved parent scope",
        outputDescriptions: ["Retained reviewer observations"],
        specRevision: 1,
        specificationGateId: spec.recordId,
        expectedSpecificationGateRevision: spec.revision,
        parentPlan: {
          recordId: plan.recordId,
          expectedRecordRevision: plan.revision,
          planRevision: plan.planRevision,
          gateId: planGate.recordId,
          expectedGateRevision: planGate.revision,
        },
      });
      state = yield* load();
      const child = state.tasks.find((task) => task.taskId !== parentId)!;
      const generatedRole = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "role-revision" }> =>
          r.kind === "role-revision",
      )!;
      const role = { ...generatedRole, recordId: "reviewer-sql-role", model: "fixture-model" };
      yield* repository.execute({
        type: "project-work.foundation.commit",
        projectId: p,
        commandId: CommandId.make("reviewer-sql-configure"),
        expectedRevision: state.revision,
        attribution: human,
        committedAt: at,
        records: [
          role,
          {
            recordId: "reviewer-sql-member",
            projectId: p,
            kind: "member",
            status: "active",
            revision: 0,
            generation: 0,
            updatedAt: at,
            name: "Reviewer",
            coordinator: false,
            roleRevisionId: role.recordId,
          },
        ],
      });
      state = yield* load();
      const grant = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
          r.kind === "gate" && r.taskId === child.taskId,
      )!;
      const binding: Extract<ProjectTeamRecord, { kind: "run-binding" }> = {
        recordId: "reviewer-sql-binding",
        projectId: p,
        kind: "run-binding",
        status: "reserved",
        revision: 0,
        generation: 0,
        updatedAt: at,
        taskId: child.taskId,
        attemptId: ProjectWorkAttemptId.make("reviewer-sql-attempt"),
        memberId: "reviewer-sql-member",
        roleRevisionId: role.recordId,
        providerInstanceId: ProviderInstanceId.make("pi-test"),
        threadId: ThreadId.make("reviewer-sql-thread"),
        environmentId: EnvironmentId.make("reviewer-sql-environment"),
        model: role.model,
        configuration: {
          instructionsHash: "fixture-instructions",
          toolIds: role.tools,
          skillIds: [],
          runtimeVersion: "fixture",
          maxTokens: 1000,
          maxDurationMs: 1000,
          paidFallback: false,
        },
        worktree: "/fixture/reviewer",
        branch: "review-fixture",
        leaseGeneration: 0,
        specRevision: 1,
        planRevision: 0,
        authorizationGateId: grant.recordId,
        scopeHash: projectTeamScopeHash(state, child.taskId),
      };
      yield* repository.execute({
        type: "project-work.foundation.commit",
        projectId: p,
        commandId: CommandId.make("reviewer-sql-claim"),
        expectedRevision: state.revision,
        attribution: {
          actor: { kind: "system", id: "scheduler" },
          source: { kind: "system", id: "scheduler" },
          recordedAt: at,
        },
        records: [],
        committedAt: at,
        transition: {
          kind: "claim",
          taskId: child.taskId,
          expectedTaskRevision: child.revision,
          authorizationGateId: grant.recordId,
          expectedGateRevision: grant.revision,
          binding,
          claim: {
            type: "project-work.task.claim",
            projectId: p,
            taskId: child.taskId,
            commandId: CommandId.make("reviewer-sql-claim"),
            attemptId: binding.attemptId,
            leaseToken: "review-sql-lease",
            leasedUntil: "2026-01-01T01:00:00.000Z",
            claimedAt: at,
          },
        },
      });
      state = yield* load();
      yield* repository.execute({
        type: "project-work.foundation.commit",
        projectId: p,
        commandId: CommandId.make("reviewer-sql-running"),
        expectedRevision: state.revision,
        attribution: human,
        records: [{ ...binding, status: "running", revision: 1 }],
        committedAt: at,
      });
      state = yield* load();
      const assignment = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
          r.kind === "task-membership" && r.taskId === child.taskId,
      )!;
      const criteria = state.criteria.filter((criterion) => criterion.taskId === child.taskId);
      expect(assignment).toMatchObject({ executionKind: "managed", deliverableKind: "review" });
      expect(criteria.length).toBeGreaterThan(0);
      const tables = [
        "project_work_events",
        "project_work_command_receipts",
        "project_work_criteria",
        "project_team_run_binding",
        "project_team_effect",
        "project_work_evidence",
        "project_work_comments",
      ];
      const rows = Effect.fn("reviewCompletionFixture.rows")(function* () {
        return yield* Effect.all(
          tables.map((table) => sql`SELECT * FROM ${sql(table)} WHERE project_id=${p}`),
        );
      });
      const agent = {
        actor: { kind: "agent" as const, id: "reviewer-sql-member" },
        source: { kind: "mcp" as const, id: "review-sql-report" },
        recordedAt: at,
      };
      const makeReport = (
        label: string,
        actor: "agent" | "human",
        retained = false,
      ): ProjectWorkCommand => {
        const intent: Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }> =
          {
            type: "project-team.assignment.report",
            projectId: p,
            taskId: child.taskId,
            commandId: CommandId.make(label),
            expectedRevision: state.revision,
            expectedTaskRevision: state.tasks.find((task) => task.taskId === child.taskId)!
              .revision,
            assignmentId: assignment.recordId,
            expectedAssignmentRevision: assignment.revision,
            specRevision: 1,
            planRevision: 0,
            summary: "Reviewer claims complete",
            evidenceIds: retained
              ? state.evidence
                  .filter((e) => e.taskId === child.taskId && e.criterionId !== undefined)
                  .map((e) => e.evidenceId)
              : [],
            outputArtifactIds: retained
              ? state.evidence
                  .filter((e) => e.taskId === child.taskId && e.criterionId !== undefined)
                  .map((e) => e.evidenceId)
              : [],
            outputs: retained
              ? []
              : criteria.map((criterion) => ({
                  criterionId: criterion.criterionId,
                  kind: "artifact",
                  detail:
                    "Nonblank actual reviewer detail retained for this exact current criterion",
                })),
            outcome: "complete",
          };
        return {
          type: "project-work.foundation.commit",
          projectId: p,
          commandId: intent.commandId,
          expectedRevision: state.revision,
          attribution: actor === "human" ? human : agent,
          records: [],
          committedAt: at,
          guided: { intent, bindingId: binding.recordId, generation: binding.generation },
        };
      };
      for (const retained of [false, true]) {
        const originalEvents = yield* repository.replay(p);
        const originalRows = yield* rows();
        const originalState = canonicalProjectWorkPayload(state);
        for (const actor of ["agent", "human"] as const) {
          const command = makeReport(`review-sql-complete-${actor}-${retained}`, actor, retained);
          const result = yield* repository.execute(command).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({
              code: "invalid-state",
              message: "Managed review completion requires a trusted completed review receipt",
            });
          expect(yield* repository.replay(p)).toEqual(originalEvents);
          expect(yield* rows()).toEqual(originalRows);
          expect(canonicalProjectWorkPayload(yield* load())).toBe(originalState);
        }
        if (!retained) {
          const report = makeReport("review-sql-findings", "agent");
          if (
            report.type !== "project-work.foundation.commit" ||
            report.guided?.intent.type !== "project-team.assignment.report"
          )
            throw new Error("Review report fixture missing");
          const proposed = yield* repository.execute({
            ...report,
            guided: { ...report.guided, intent: { ...report.guided.intent, outcome: "findings" } },
          });
          expect(
            proposed.events.some((event) => event.type === "project-work.task.completed"),
          ).toBe(false);
          const next = yield* load();
          expect(next.criteria).toEqual(state.criteria);
          expect(next.tasks).toEqual(state.tasks);
          expect(next.foundationRecords).toEqual(state.foundationRecords);
          expect(
            next.evidence.filter((e) => e.taskId === child.taskId && e.criterionId !== undefined),
          ).toHaveLength(criteria.length);
          state = next;
        }
      }
    }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
  );

  it.effect("replays an accepted zero-event receipt only after live authorization", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runForkMigrations();
      const repository = yield* ProjectWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const command: ProjectWorkCommand = {
        type: "project-work.foundation.commit",
        projectId: ProjectId.make("zero-event-receipt"),
        commandId: CommandId.make("zero-event-report"),
        expectedRevision: 0,
        records: [],
        committedAt: at,
        attribution: {
          actor: { kind: "agent", id: "authorized-reviewer" },
          source: { kind: "mcp", id: "review-report" },
          recordedAt: at,
        },
      };
      let authorized = 0;
      let live = true;
      const observedDuplicates: boolean[] = [];
      const execute = () =>
        repository.executeAuthorized(
          command,
          () => {
            authorized++;
            return Effect.succeed(command);
          },
          ({ duplicate }) => {
            observedDuplicates.push(duplicate);
            return live ? Effect.void : Effect.fail("reviewer-revoked");
          },
        );
      const first = yield* execute();
      expect(first.events).toEqual([]);
      expect(first.writeResult.receipt.eventCount).toBe(0);
      const second = yield* execute();
      expect(second.duplicate).toBe(true);
      expect(second.writeResult).toEqual(first.writeResult);
      expect(observedDuplicates).toEqual([false, true]);
      expect(authorized).toBe(1);
      live = false;
      expect((yield* execute().pipe(Effect.result))._tag).toBe("Failure");
      expect(authorized).toBe(1);
      expect(
        (yield* repository
          .execute({
            ...command,
            attribution: {
              ...command.attribution!,
              actor: { kind: "agent", id: "other-reviewer" },
            },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        yield* sql`SELECT * FROM project_work_events WHERE project_id=${command.projectId}`,
      ).toHaveLength(0);
      expect(
        yield* sql`SELECT * FROM project_work_command_receipts WHERE project_id=${command.projectId}`,
      ).toHaveLength(1);
    }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
  );
  for (const outcome of ["denial", "defect", "interrupt"] as const)
    it.effect(`retains transaction cause and policy certainty for ${outcome}`, () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runForkMigrations();
        const repository = yield* ProjectWorkRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TEMP TABLE policy_callback_mutation (marker TEXT)`;
        const denial = new ProjectWorkPolicyError("authority-required", "callback denied");
        const failure =
          outcome === "denial"
            ? Cause.fail(denial)
            : Cause.combine(
                Cause.fail(denial),
                outcome === "defect" ? Cause.die("callback defect") : Cause.interrupt(),
              );
        const exit = yield* repository
          .executeAuthorized(
            {
              type: "project-work.task.create",
              projectId,
              taskId,
              commandId: CommandId.make(`callback-${outcome}`),
              title: "Denied callback",
              createdAt: at,
            },
            () =>
              sql`INSERT INTO policy_callback_mutation VALUES ('pending')`.pipe(
                Effect.andThen(Effect.failCause(failure)),
              ),
          )
          .pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(Cause.hasDies(exit.cause)).toBe(outcome === "defect");
          expect(Cause.hasInterrupts(exit.cause)).toBe(outcome === "interrupt");
          const selected = Cause.findError(exit.cause);
          expect(selected._tag).toBe("Success");
          if (selected._tag === "Success") {
            if (outcome === "denial") expect(selected.success).toBe(denial);
            else
              expect(selected.success).toMatchObject({
                _tag: "PersistenceSqlError",
                cause: failure,
              });
          }
        }
        expect(yield* sql`SELECT * FROM policy_callback_mutation`).toHaveLength(0);
        expect(
          yield* sql`SELECT * FROM project_work_command_receipts WHERE command_id=${`callback-${outcome}`}`,
        ).toHaveLength(0);
        yield* sql`DROP TABLE policy_callback_mutation`;
      }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
    );
  it.effect(
    "guided investigation rolls back every generated record and receipt, then commits once",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runForkMigrations();
        const repository = yield* ProjectWorkRepository;
        const sql = yield* SqlClient.SqlClient;
        const p = ProjectId.make("guided-atomic-sql");
        const t = ProjectWorkTaskId.make("guided-parent-sql");
        const human = {
          actor: { kind: "human" as const, id: "maintainer" },
          source: { kind: "web" as const, id: "sql-client" },
          recordedAt: at,
        };
        yield* repository.execute({
          type: "project-work.task.create",
          projectId: p,
          taskId: t,
          commandId: CommandId.make("guided-capture-sql"),
          title: "Unspecified capture",
          createdAt: at,
        });
        const current = applyProjectWorkEvents(
          emptyProjectWorkReducerState(p),
          yield* repository.replay(p),
        );
        const intent: ProjectTeamGuidedIntent = {
          type: "project-team.investigation.start",
          projectId: p,
          taskId: t,
          commandId: CommandId.make("guided-investigate-sql"),
          expectedRevision: current.revision,
          expectedTaskRevision: 0,
          objective: "Find the cause",
          outputDescriptions: ["Retained findings"],
        };
        const command: ProjectWorkCommand = {
          type: "project-work.foundation.commit",
          projectId: p,
          commandId: intent.commandId,
          expectedRevision: current.revision,
          attribution: human,
          records: [],
          guided: { intent },
          committedAt: at,
        };
        yield* sql`CREATE TRIGGER p4_reject_generated_role BEFORE INSERT ON project_team_role_revision WHEN NEW.project_id='guided-atomic-sql' BEGIN SELECT RAISE(ABORT,'P4 rollback proof'); END`;
        expect((yield* repository.execute(command).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* sql`SELECT record_id FROM project_team_gate WHERE project_id=${p}`).length,
        ).toBe(0);
        expect(
          (yield* sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${p} AND command_id=${intent.commandId}`)
            .length,
        ).toBe(0);
        expect((yield* repository.replay(p)).length).toBe(1);
        yield* sql`DROP TRIGGER p4_reject_generated_role`;
        const result = yield* repository.execute(command);
        const duplicate = yield* repository.execute(command);
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.writeResult).toEqual(result.writeResult);
        const state = applyProjectWorkEvents(
          emptyProjectWorkReducerState(p),
          yield* repository.replay(p),
        );
        expect(state.tasks).toHaveLength(2);
        expect(state.attempts).toEqual([]);
        expect(state.tasks.find((entry) => entry.taskId === t)).toMatchObject({
          state: "draft",
          revision: 0,
          specRevision: 0,
        });
        expect(
          (yield* sql`SELECT record_id FROM project_team_gate WHERE project_id=${p}`).length,
        ).toBe(1);
        const childMembership = state.foundationRecords!.find(
          (r) => r.kind === "task-membership" && r.parentTaskId === t,
        )!;
        yield* repository.execute({
          type: "project-work.foundation.commit",
          projectId: p,
          commandId: CommandId.make("guided-pause-sql"),
          expectedRevision: state.revision,
          attribution: human,
          records: [],
          committedAt: at,
          guided: {
            intent: {
              type: "project-team.task.control",
              projectId: p,
              taskId: ProjectWorkTaskId.make(
                "taskId" in childMembership ? childMembership.taskId! : "missing",
              ),
              commandId: CommandId.make("guided-pause-sql"),
              expectedRevision: state.revision,
              expectedTaskRevision: state.tasks.find((entry) => entry.taskId !== t)!.revision,
              control: { action: "pause", reason: "Human stops research" },
            },
          },
        });
        expect((yield* repository.execute(command).pipe(Effect.result))._tag).toBe("Failure");
      }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
  );

  it.effect("concurrent human investigation requests with one revision have one SQL winner", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runForkMigrations();
      const repository = yield* ProjectWorkRepository;
      const p = ProjectId.make("guided-race-sql");
      const t = ProjectWorkTaskId.make("guided-race-parent");
      yield* repository.execute({
        type: "project-work.task.create",
        projectId: p,
        taskId: t,
        commandId: CommandId.make("guided-race-capture"),
        title: "Capture",
        createdAt: at,
      });
      const commands = ["first", "second"].map((suffix): ProjectWorkCommand => ({
        type: "project-work.foundation.commit",
        projectId: p,
        commandId: CommandId.make(`guided-race-${suffix}`),
        expectedRevision: 1,
        records: [],
        committedAt: at,
        attribution: {
          actor: { kind: "human", id: `device-${suffix}` },
          source: { kind: "web", id: suffix },
          recordedAt: at,
        },
        guided: {
          intent: {
            type: "project-team.investigation.start",
            projectId: p,
            taskId: t,
            commandId: CommandId.make(`guided-race-${suffix}`),
            expectedRevision: 1,
            expectedTaskRevision: 0,
            objective: "Investigate",
            outputDescriptions: ["Findings"],
          },
        },
      }));
      const results = yield* Effect.forEach(
        commands,
        (command) => repository.execute(command).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const state = applyProjectWorkEvents(
        emptyProjectWorkReducerState(p),
        yield* repository.replay(p),
      );
      expect(state.tasks).toHaveLength(2);
      expect(
        state.foundationRecords!.filter((r) => r.kind === "gate" && r.gate === "investigation"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
  );
  it.effect(
    "revalidates live authority before duplicate receipts without consuming approval twice",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repository = yield* ProjectWorkRepository;
        const command = {
          type: "project-work.task.create" as const,
          projectId: ProjectId.make("live-authority-project"),
          taskId: ProjectWorkTaskId.make("live-authority-task"),
          commandId: CommandId.make("live-authority-duplicate"),
          title: "Live authority",
          createdAt: at,
        };
        let consumed = 0;
        let live = true;
        const execute = () =>
          repository.executeAuthorized(
            command,
            () => {
              consumed++;
              return Effect.succeed(command);
            },
            () => (live ? Effect.void : Effect.fail("credential-revoked")),
          );
        yield* execute();
        yield* execute();
        expect(consumed).toBe(1);
        live = false;
        expect((yield* execute().pipe(Effect.result))._tag).toBe("Failure");
        expect(consumed).toBe(1);
      }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
  );

  it.effect(
    "persists server-owned criterion revisions through checkpoints, FTS, and rebuilds",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repository = yield* ProjectWorkRepository;
        const query = yield* ProjectWorkQuery;
        const projection = yield* ProjectWorkProjection;
        const search = yield* ProjectWorkSearch;
        const sql = yield* SqlClient.SqlClient;
        const criterionProjectId = ProjectId.make("criterion-revision-repository");
        const criterionTaskId = ProjectWorkTaskId.make("criterion-revision-task");
        const criterionId = ProjectWorkCriterionId.make("criterion-revision-record");

        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("criterion-revision-create"),
          projectId: criterionProjectId,
          taskId: criterionTaskId,
          title: "Criterion revision task",
          createdAt: at,
        });
        for (const [index, suppliedRevision, description] of [
          [0, 4, "Initial representative criterion"],
          [1, 1, "Lower caller revision searchable"],
          [2, 99, "Higher caller revision searchable"],
        ] as const)
          yield* repository.execute({
            type: "project-work.criterion.upsert",
            commandId: CommandId.make(`criterion-revision-upsert-${index}`),
            projectId: criterionProjectId,
            taskId: criterionTaskId,
            criterion: {
              criterionId,
              taskId: criterionTaskId,
              description,
              required: index !== 2,
              status: index === 1 ? "satisfied" : "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: suppliedRevision,
              updatedAt: "1999-01-01T00:00:00.000Z",
            },
            updatedAt: `2026-01-01T00:00:0${index + 1}.000Z`,
          });

        const before = yield* query.snapshot(String(criterionProjectId));
        expect(before.criteria).toEqual([
          expect.objectContaining({
            criterionId,
            description: "Higher caller revision searchable",
            required: false,
            status: "unsatisfied",
            revision: 6,
            updatedAt: "2026-01-01T00:00:03.000Z",
          }),
        ]);
        const checkpoint = yield* sql<{ readonly stateJson: string }>`
          SELECT state_json AS stateJson FROM project_work_reducer_checkpoints
          WHERE project_id = ${criterionProjectId}
        `;
        const checkpointState = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              criteria: Schema.Array(
                Schema.Struct({ revision: Schema.Number, description: Schema.String }),
              ),
            }),
          ),
        )(checkpoint[0]!.stateJson);
        expect(checkpointState.criteria).toEqual([
          expect.objectContaining({
            revision: 6,
            description: "Higher caller revision searchable",
          }),
        ]);
        const found = yield* search.search({
          projectId: String(criterionProjectId),
          query: "Higher caller revision searchable",
          recordKinds: ["criterion"],
        });
        expect(found.items).toEqual([
          expect.objectContaining({ recordId: criterionId, revision: 6 }),
        ]);

        yield* projection.rebuild(String(criterionProjectId));
        expect(yield* query.snapshot(String(criterionProjectId))).toEqual(before);
        expect(
          yield* search.search({
            projectId: String(criterionProjectId),
            query: "Higher caller revision searchable",
            recordKinds: ["criterion"],
          }),
        ).toEqual(found);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProjectWorkRepositoryLive,
            ProjectWorkQueryLive,
            ProjectWorkProjectionLive,
            ProjectWorkSearchLive,
          ),
        ),
      ),
  );

  it.effect("appends events and only exposes committed normalized rows", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("repo-create"),
        projectId,
        taskId,
        title: "Durable task",
        createdAt: at,
      });
      const row = yield* query.getTask(String(projectId), taskId);
      expect(Option.isSome(row)).toBe(true);
      const events = yield* repository.replay(String(projectId));
      expect(events.map((event) => event.type)).toEqual(["project-work.task.created"]);
      const duplicate = yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("repo-create"),
        projectId,
        taskId,
        title: "Durable task",
        createdAt: at,
      });
      expect(duplicate.events.map((event) => event.type)).toEqual(["project-work.task.created"]);
      const raw = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id = ${projectId}`;
      expect(Number(raw[0]?.count)).toBe(1);
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkQueryLive))),
  );

  it.effect("deduplicates a renewed MCP source before any approval hook runs", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const attributed = {
        type: "project-work.task.create" as const,
        commandId: CommandId.make("repo-renewed-mcp"),
        projectId,
        taskId: ProjectWorkTaskId.make("repo-renewed-task"),
        title: "Renewed MCP task",
        createdAt: at,
        attribution: {
          actor: { kind: "agent" as const, id: "agent:mcp:codex:thread-1" },
          source: {
            kind: "mcp" as const,
            id: "mcp:codex:thread-1",
            uri: "mcp://provider/codex/thread-1?session=first",
          },
          recordedAt: at,
        },
      };
      const first = yield* repository.execute(attributed);
      let authorizationCalls = 0;
      const duplicate = yield* repository.executeAuthorized(
        {
          ...attributed,
          attribution: {
            ...attributed.attribution,
            source: {
              ...attributed.attribution.source,
              uri: "mcp://provider/codex/thread-1?session=renewed",
            },
          },
        },
        () => {
          authorizationCalls += 1;
          return Effect.succeed(attributed);
        },
      );
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId),
      );
      expect(authorizationCalls).toBe(0);
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkQueryLive))),
  );

  it.effect("removes unlinked relationships from fresh query and rebuild", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const relationProjectId = ProjectId.make("project-repository-relationship");
      const fromTaskId = ProjectWorkTaskId.make("relationship-from");
      const toTaskId = ProjectWorkTaskId.make("relationship-to");
      for (const [commandId, taskId, title] of [
        ["relationship-create-from", fromTaskId, "From"],
        ["relationship-create-to", toTaskId, "To"],
      ] as const)
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make(commandId),
          projectId: relationProjectId,
          taskId,
          title,
          createdAt: at,
        });
      const relationshipId = ProjectWorkRelationshipId.make("relationship-1");
      yield* repository.execute({
        type: "project-work.relationship.link",
        commandId: CommandId.make("relationship-link"),
        projectId: relationProjectId,
        relationship: {
          relationshipId,
          projectId: relationProjectId,
          fromTaskId,
          toTaskId,
          kind: "relates-to",
          revision: 0,
          createdAt: at,
        },
        linkedAt: at,
      });
      expect(
        yield* query.listRelationships({
          projectId: String(relationProjectId),
        }),
      ).toHaveLength(1);
      yield* repository.execute({
        type: "project-work.relationship.unlink",
        commandId: CommandId.make("relationship-unlink"),
        projectId: relationProjectId,
        relationshipId,
        unlinkedAt: at,
      });
      expect(
        yield* query.listRelationships({
          projectId: String(relationProjectId),
        }),
      ).toHaveLength(0);
      yield* projection.rebuild(String(relationProjectId));
      expect(
        yield* query.listRelationships({
          projectId: String(relationProjectId),
        }),
      ).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkQueryLive, ProjectWorkProjectionLive),
        ),
      ),
    ),
  );

  it.effect("rolls back the event append when projection persistence fails", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const sql = yield* SqlClient.SqlClient;
      const failedProjectId = ProjectId.make("project-repository-rollback");
      const failedTaskId = ProjectWorkTaskId.make("task-repository-rollback");
      yield* sql`
        CREATE TRIGGER project_work_test_reject BEFORE INSERT ON project_work_tasks
        WHEN NEW.title = 'Abort'
        BEGIN SELECT RAISE(ABORT, 'projection failure'); END
      `;
      const result = yield* Effect.result(
        repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("rollback-create"),
          projectId: failedProjectId,
          taskId: failedTaskId,
          title: "Abort",
          createdAt: at,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(Option.isNone(yield* query.getTask(String(failedProjectId), failedTaskId))).toBe(true);
      expect(yield* repository.replay(String(failedProjectId))).toHaveLength(0);
      yield* sql`DROP TRIGGER project_work_test_reject`;
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkQueryLive))),
  );

  it.effect("fences worker lifecycle writes and rebuilds from the authoritative log", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const projectId = ProjectId.make("project-repository-life");
      const taskId = ProjectWorkTaskId.make("task-repository-life");
      const worker: ProjectWorkAttribution = {
        actor: { kind: "agent", id: "agent-1" },
        source: { kind: "provider", id: "provider-1" },
        recordedAt: at,
      };
      const human = {
        actor: { kind: "human", id: "human-1" },
        source: { kind: "web", id: "web-1" },
        recordedAt: at,
      } satisfies ProjectWorkAttribution;
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("life-create"),
        projectId,
        taskId,
        title: "Lifecycle",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.criterion.upsert",
        commandId: CommandId.make("life-criterion"),
        projectId,
        taskId,
        criterion: {
          criterionId: ProjectWorkCriterionId.make("life-criterion"),
          taskId,
          description: "Done",
          required: true,
          status: "satisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        },
        updatedAt: at,
      });
      yield* repository.execute({
        type: "project-work.task.specify",
        commandId: CommandId.make("life-specify"),
        projectId,
        taskId,
        specification: {
          objective: "Ship",
          scopeIn: "Feature",
          scopeOut: "Other",
          criterionIds: [ProjectWorkCriterionId.make("life-criterion")],
          revision: 1,
          protected: false,
        },
        updatedAt: at,
      });
      yield* repository.execute({
        type: "project-work.task.ready",
        commandId: CommandId.make("life-ready"),
        projectId,
        taskId,
        updatedAt: at,
      });
      const attemptId = ProjectWorkAttemptId.make("life-attempt-z");
      yield* repository.execute({
        type: "project-work.task.claim",
        commandId: CommandId.make("life-claim"),
        projectId,
        taskId,
        attemptId,
        leaseToken: "token-1",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.fail",
        commandId: CommandId.make("life-fail"),
        projectId,
        taskId,
        attemptId,
        leaseToken: "token-1",
        failureKind: "recoverable",
        reason: "Transient",
        failedAt: at,
        attribution: worker,
      });
      const resolved = yield* repository.execute({
        type: "project-work.task.resolve-failure",
        commandId: CommandId.make("life-resolve"),
        projectId,
        taskId,
        reason: "Retry",
        evidenceIds: [],
        resolvedAt: at,
        attribution: human,
      });
      expect(resolved.state.tasks[0]?.failureKind).toBeUndefined();
      const stale = yield* Effect.result(
        repository.execute({
          type: "project-work.task.fail",
          commandId: CommandId.make("life-stale"),
          projectId,
          taskId,
          attemptId,
          leaseToken: "token-1",
          failureKind: "recoverable",
          reason: "Stale",
          failedAt: "2026-01-01T00:30:00.000Z",
          attribution: worker,
        }),
      );
      expect(stale._tag).toBe("Failure");
      const attempts = yield* query.listAttempts({ projectId });
      const failedAttempt = attempts.find((attempt) => attempt.attemptId === attemptId);
      expect(failedAttempt?.state).toBe("failed");
      expect(failedAttempt?.failureReason).toBe("Transient");
      expect(failedAttempt?.failureResolutionReason).toBe("Retry");
      expect(failedAttempt?.failureResolutionAttribution?.actor.kind).toBe("human");
      const secondAttemptId = ProjectWorkAttemptId.make("life-attempt-a");
      yield* repository.execute({
        type: "project-work.task.claim",
        commandId: CommandId.make("life-claim-second"),
        projectId,
        taskId,
        attemptId: secondAttemptId,
        leaseToken: "token-2",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.fail",
        commandId: CommandId.make("life-fail-second"),
        projectId,
        taskId,
        attemptId: secondAttemptId,
        leaseToken: "token-2",
        failureKind: "recoverable",
        reason: "Transient again",
        failedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.resolve-failure",
        commandId: CommandId.make("life-resolve-second"),
        projectId,
        taskId,
        reason: "Retry again",
        evidenceIds: [],
        resolvedAt: at,
        attribution: human,
      });
      const thirdAttemptId = ProjectWorkAttemptId.make("life-attempt-0");
      yield* repository.execute({
        type: "project-work.task.claim",
        commandId: CommandId.make("life-claim-third"),
        projectId,
        taskId,
        attemptId: thirdAttemptId,
        leaseToken: "token-3",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.fail",
        commandId: CommandId.make("life-fail-third"),
        projectId,
        taskId,
        attemptId: thirdAttemptId,
        leaseToken: "token-3",
        failureKind: "recoverable",
        reason: "Latest transient failure",
        failedAt: at,
        attribution: worker,
      });
      const canonicalAttemptIds = () =>
        query
          .listAttempts({ projectId, taskId, canonical: true, trusted: true })
          .pipe(Effect.map((entries) => entries.map((entry) => entry.attemptId)));
      expect(yield* canonicalAttemptIds()).toEqual([attemptId, secondAttemptId, thirdAttemptId]);
      expect(
        (yield* query.listAttempts({ projectId, taskId })).map((entry) => entry.attemptId),
      ).toEqual([thirdAttemptId, secondAttemptId, attemptId]);
      const context = yield* query.getTaskContext(String(projectId), taskId);
      expect(Option.getOrThrow(context).policy.actions.reclaim.available).toBe(true);
      yield* query.getActiveAttempt(String(projectId), taskId);
      const rebuilt = yield* projection.rebuild(String(projectId));
      expect(rebuilt).toBeUndefined();
      expect(yield* canonicalAttemptIds()).toEqual([attemptId, secondAttemptId, thirdAttemptId]);
      const rebuiltContext = yield* query.getTaskContext(String(projectId), taskId);
      expect(Option.getOrThrow(rebuiltContext).policy.actions.reclaim.available).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkQueryLive, ProjectWorkProjectionLive),
        ),
      ),
    ),
  );

  it.effect("persists deferred knowledge, decisions, comments, and attention", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const sql = yield* SqlClient.SqlClient;
      const deferredProjectId = ProjectId.make("project-repository-deferred");
      const deferredTaskId = ProjectWorkTaskId.make("task-repository-deferred");
      const attribution: ProjectWorkAttribution = {
        actor: { kind: "human", id: "human-deferred" },
        source: { kind: "web", id: "web-deferred" },
        recordedAt: at,
      };
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("deferred-create"),
        projectId: deferredProjectId,
        taskId: deferredTaskId,
        title: "Deferred records",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.knowledge.promote",
        commandId: CommandId.make("deferred-knowledge"),
        projectId: deferredProjectId,
        knowledge: {
          knowledgeId: ProjectWorkKnowledgeId.make("deferred-knowledge"),
          projectId: deferredProjectId,
          title: "Known fact",
          body: "Keep this after source removal.",
          sourceKind: "task",
          sourceId: deferredTaskId,
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        promotedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.propose",
        commandId: CommandId.make("deferred-decision-propose"),
        projectId: deferredProjectId,
        decision: {
          decisionId: ProjectWorkDecisionId.make("deferred-decision"),
          projectId: deferredProjectId,
          title: "Choose",
          body: "Original proposal body",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        proposedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.accept",
        commandId: CommandId.make("deferred-decision-accept"),
        projectId: deferredProjectId,
        decisionId: ProjectWorkDecisionId.make("deferred-decision"),
        acceptedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.supersede",
        commandId: CommandId.make("deferred-decision-supersede"),
        projectId: deferredProjectId,
        decisionId: ProjectWorkDecisionId.make("deferred-decision"),
        replacement: {
          decisionId: ProjectWorkDecisionId.make("deferred-replacement"),
          projectId: deferredProjectId,
          title: "Choose again",
          body: "Replacement proposal",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        supersededAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.comment.add",
        commandId: CommandId.make("deferred-comment"),
        projectId: deferredProjectId,
        comment: {
          commentId: ProjectWorkCommentId.make("deferred-comment"),
          projectId: deferredProjectId,
          taskId: deferredTaskId,
          body: "A durable comment",
          createdAt: at,
          revision: 0,
        },
        addedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.attention.seen",
        commandId: CommandId.make("deferred-attention"),
        projectId: deferredProjectId,
        taskId: deferredTaskId,
        seenAt: at,
        attribution,
      });
      expect(yield* query.listKnowledge({ projectId: String(deferredProjectId) })).toHaveLength(1);
      const decisions = yield* query.listDecisions({
        projectId: String(deferredProjectId),
      });
      expect(decisions.map((decision) => [decision.title, decision.state, decision.body])).toEqual([
        ["Choose", "superseded", "Original proposal body"],
        ["Choose again", "proposed", "Replacement proposal"],
      ]);
      expect(yield* query.listComments({ projectId: String(deferredProjectId) })).toHaveLength(1);
      expect(yield* query.listAttention({ projectId: String(deferredProjectId) })).toHaveLength(1);
      const eventsBeforeRebuild = yield* repository.replay(String(deferredProjectId));
      const knowledgeBeforeRebuild = yield* query.listKnowledge({
        projectId: String(deferredProjectId),
      });
      const attentionBeforeRebuild = yield* query.listAttention({
        projectId: String(deferredProjectId),
      });
      expect(eventsBeforeRebuild.map((event) => event.type)).toEqual([
        "project-work.task.created",
        "project-work.knowledge.promoted",
        "project-work.decision.proposed",
        "project-work.decision.accepted",
        "project-work.decision.superseded",
        "project-work.comment.added",
        "project-work.attention.seen",
      ]);
      // Simulate projection damage without touching the authoritative event log.
      yield* sql`DELETE FROM project_work_knowledge WHERE project_id = ${deferredProjectId}`;
      yield* sql`DELETE FROM project_work_decisions WHERE project_id = ${deferredProjectId}`;
      yield* sql`DELETE FROM project_work_attention WHERE project_id = ${deferredProjectId}`;
      yield* projection.rebuild(String(deferredProjectId));
      expect(yield* query.listKnowledge({ projectId: String(deferredProjectId) })).toEqual(
        knowledgeBeforeRebuild,
      );
      expect(yield* query.listDecisions({ projectId: String(deferredProjectId) })).toEqual(
        decisions,
      );
      expect(yield* query.listAttention({ projectId: String(deferredProjectId) })).toEqual(
        attentionBeforeRebuild,
      );
      expect(yield* repository.replay(String(deferredProjectId))).toEqual(eventsBeforeRebuild);
      expect(yield* query.listComments({ projectId: String(deferredProjectId) })).toHaveLength(1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkQueryLive, ProjectWorkProjectionLive),
        ),
      ),
    ),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TeamAuthorization from "./ProjectTeamAuthorization.ts";
import {
  seed as seedTeam,
  decodeRecord,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import * as EventBus from "./ProjectWorkEventBus.ts";

const bindingServices = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  ProjectWorkProjectionLive,
  TeamAuthorization.layer,
).pipe(Layer.provideMerge(EventBus.ProjectWorkEventBusLive));

const insertBindingSession = Effect.fn("repositoryTest.insertBindingSession")(function* (
  id: string,
  subject = "agent:mcp:pi:authorization-thread",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO auth_sessions (session_id,subject,scopes,method,issued_at,expires_at)
    VALUES (${id},${subject},'[]','bearer-access-token',${at},'2030-01-01T00:00:00.000Z')`;
});

it.effect(
  "guided assignment and retained outputs survive file-backed restart and projection rebuild",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-p4-guided-restart-" });
      const database = () =>
        Layer.fresh(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }));
      const p = ProjectId.make("guided-restart");
      const t = ProjectWorkTaskId.make("guided-restart-parent");
      const human = {
        actor: { kind: "human" as const, id: "maintainer" },
        source: { kind: "web" as const, id: "restart-client" },
        recordedAt: at,
      };
      const services = Layer.mergeAll(ProjectWorkRepositoryLive, ProjectWorkProjectionLive);
      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          yield* runForkMigrations();
          const repository = yield* ProjectWorkRepository;
          yield* repository.execute({
            type: "project-work.task.create",
            projectId: p,
            taskId: t,
            commandId: CommandId.make("restart-capture"),
            title: "Captured issue",
            createdAt: at,
          });
          yield* repository.execute({
            type: "project-work.foundation.commit",
            projectId: p,
            commandId: CommandId.make("restart-investigation"),
            expectedRevision: 1,
            attribution: human,
            records: [],
            committedAt: at,
            guided: {
              intent: {
                type: "project-team.investigation.start",
                projectId: p,
                taskId: t,
                commandId: CommandId.make("restart-investigation"),
                expectedRevision: 1,
                expectedTaskRevision: 0,
                objective: "Bounded research",
                outputDescriptions: ["Retained source findings"],
              },
            },
          });
          let state = applyProjectWorkEvents(
            emptyProjectWorkReducerState(p),
            yield* repository.replay(p),
          );
          const child = state.tasks.find((task) => task.taskId !== t)!;
          const assignment = state.foundationRecords!.find(
            (r) => r.kind === "task-membership" && r.taskId === child.taskId,
          )!;
          yield* repository.execute({
            type: "project-work.foundation.commit",
            projectId: p,
            commandId: CommandId.make("restart-report"),
            expectedRevision: state.revision,
            attribution: human,
            records: [],
            committedAt: at,
            guided: {
              intent: {
                type: "project-team.assignment.report",
                projectId: p,
                taskId: child.taskId,
                commandId: CommandId.make("restart-report"),
                expectedRevision: state.revision,
                expectedTaskRevision: child.revision,
                assignmentId: assignment.recordId,
                expectedAssignmentRevision: assignment.revision,
                specRevision: 1,
                planRevision: 0,
                summary: "Source finding",
                outputs: [
                  {
                    kind: "observation",
                    criterionId: state.criteria[0]!.criterionId,
                    detail: "Retained finding cites the actual project source.",
                  },
                ],
                evidenceIds: [],
                outputArtifactIds: [],
                outcome: "complete",
              },
            },
          });
          state = applyProjectWorkEvents(
            emptyProjectWorkReducerState(p),
            yield* repository.replay(p),
          );
          return state;
        }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database())))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* ProjectWorkRepository;
          const projection = yield* ProjectWorkProjection;
          const sql = yield* SqlClient.SqlClient;
          const after = applyProjectWorkEvents(
            emptyProjectWorkReducerState(p),
            yield* repository.replay(p),
          );
          expect(after).toEqual(before);
          yield* sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${p}`;
          yield* projection.rebuild(p);
          const rebuilt = applyProjectWorkEvents(
            emptyProjectWorkReducerState(p),
            yield* repository.replay(p),
          );
          expect(rebuilt).toEqual(before);
          expect(
            (yield* sql`SELECT payload_json FROM project_team_task_membership WHERE project_id=${p}`)
              .length,
          ).toBe(2);
          expect(rebuilt.evidence[0]!.detail).toContain("Retained finding");
          expect(rebuilt.evidence[0]!.scopeHash).toMatch(/^[a-f0-9]{64}$/);
        }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database())))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

for (const failure of [
  "projection-failure",
  "interruption",
  "receipt-failure",
  "withdrawal-interruption",
] as const)
  it.effect(`withdraws legacy credentials atomically with binding after ${failure} rollback`, () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const bus = yield* EventBus.ProjectWorkEventBus;
      let publications = 0;
      let beforeDispatch = 0;
      let dispatch: ProjectWorkCommand | undefined;
      const inserted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let intercepted = false;
      const transactionSql = new Proxy(sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (!Array.isArray(args[0]) || !("raw" in args[0])) return statement;
          if (
            !intercepted &&
            ((failure === "interruption" &&
              statement.compile()[0].includes("INSERT INTO") &&
              statement.compile()[0].includes("project_team_run_binding")) ||
              (failure === "withdrawal-interruption" &&
                statement.compile()[0].includes("UPDATE auth_sessions")))
          ) {
            intercepted = true;
            return statement.pipe(
              Effect.tap(() =>
                Deferred.succeed(inserted, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            );
          }
          return statement;
        },
      });
      const repository = yield* ProjectWorkRepository.pipe(
        Effect.provide(Layer.fresh(ProjectWorkRepositoryLive)),
        Effect.provideService(SqlClient.SqlClient, transactionSql),
        Effect.provideService(
          EventBus.ProjectWorkEventBus,
          EventBus.ProjectWorkEventBus.of({
            ...bus,
            publish: (events) => {
              publications += events.length;
              return bus.publish(events);
            },
          }),
        ),
      );
      const observed = ProjectWorkRepository.of({
        ...repository,
        execute: (command) => {
          if (command.commandId === "dispatch") {
            dispatch = command;
            beforeDispatch = publications;
          }
          return repository.execute(command);
        },
      });
      for (const [id, subject] of [
        ["legacy-a", "agent:mcp:pi:authorization-thread"],
        ["legacy-b", "agent:mcp:pi:authorization-thread"],
        ["other-provider", "agent:mcp:codex:authorization-thread"],
        ["other-thread", "agent:mcp:pi:other-thread"],
        ["ordinary", "agent:ordinary"],
        ["managed", "agent:project-team:reserved"],
      ])
        yield* insertBindingSession(id!, subject!);
      if (failure === "projection-failure")
        yield* sql`CREATE TRIGGER reject_binding BEFORE INSERT ON project_team_run_binding
          BEGIN SELECT RAISE(ABORT,'binding projection failure'); END`;
      if (failure === "receipt-failure")
        yield* sql`CREATE TRIGGER reject_receipt BEFORE INSERT ON project_work_command_receipts
          WHEN NEW.command_id='dispatch' BEGIN SELECT RAISE(ABORT,'binding receipt failure'); END`;
      const setup = seedTeam("implementer", "running", { issueCredential: false }).pipe(
        Effect.provideService(ProjectWorkRepository, observed),
      );
      if (failure === "projection-failure" || failure === "receipt-failure")
        expect((yield* setup.pipe(Effect.result))._tag).toBe("Failure");
      else {
        const pending = yield* setup.pipe(Effect.forkScoped);
        yield* Deferred.await(inserted);
        yield* Fiber.interrupt(pending);
        expect((yield* Fiber.await(pending))._tag).toBe("Failure");
        expect(yield* Deferred.isDone(release)).toBe(false);
      }
      expect(publications).toBe(beforeDispatch);
      expect(yield* sql`SELECT * FROM auth_sessions WHERE revoked_at IS NOT NULL`).toHaveLength(0);
      for (const name of [
        "project_team_run_binding",
        "project_team_effect",
        "project_team_identity_fences",
        "project_work_attempts",
      ])
        expect(yield* sql`SELECT * FROM ${sql(name)}`).toHaveLength(0);
      for (const name of ["project_work_events", "project_work_command_receipts"])
        expect(yield* sql`SELECT * FROM ${sql(name)} WHERE command_id='dispatch'`).toHaveLength(0);
      expect(dispatch).toBeDefined();
      if (failure === "projection-failure") yield* sql`DROP TRIGGER reject_binding`;
      if (failure === "receipt-failure") yield* sql`DROP TRIGGER reject_receipt`;
      const committed = yield* repository.execute(dispatch!);
      expect(publications).toBe(beforeDispatch + committed.events.length);
      expect((yield* repository.execute(dispatch!)).duplicate).toBe(true);
      expect(publications).toBe(beforeDispatch + committed.events.length);
      const revoked = yield* sql<{ id: string }>`SELECT session_id AS id FROM auth_sessions
        WHERE revoked_at IS NOT NULL ORDER BY session_id`;
      expect(revoked.map((row) => row.id)).toEqual(["legacy-a", "legacy-b"]);
      expect(yield* sql`SELECT * FROM project_team_run_binding`).toHaveLength(1);
      expect(yield* sql`SELECT * FROM project_team_identity_fences`).toEqual([
        { provider_instance_id: "pi", thread_id: "authorization-thread" },
      ]);
      expect(
        yield* sql`SELECT * FROM project_work_command_receipts WHERE command_id='dispatch'`,
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        bindingServices.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

it.effect(
  "preserves binding withdrawal through Human pause, a new assignment and file-backed restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-binding-withdrawal-" });
      const database = () =>
        bindingServices.pipe(
          Layer.provideMerge(
            Layer.fresh(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") })),
          ),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations({ toForkMigrationInclusive: 19 });
          yield* insertBindingSession("created");
          expect(yield* runForkMigrations()).toEqual([
            [20, "ProjectTeamIdentityFences"],
            [21, "ProjectWorkEvidenceMetadata"],
            [22, "ProjectIssueRepositories"],
            [23, "ProjectTeamModelRequests"],
            [24, "ProjectTeamPiOperations"],
            [25, "ProjectTeamDispatch"],
            [26, "ProjectTeamTransportCapacity"],
            [27, "ProjectTeamSetupJournal"],
            [28, "ProjectTeamWorkspaceReceipt"],
            [29, "ProjectTeamMemoryJournal"],
            [30, "ProjectTeamMemoryOutcome"],
            [31, "ProjectTeamReviewFreshness"],
            [32, "ProjectWorkArtifacts"],
            [33, "ProjectWorkVerificationJobs"],
            [34, "ProjectWorkVerificationExecution"],
            [35, "ProjectTeamReviewTargets"],
            [36, "ProjectTeamReviewFindings"],
            [37, "ProjectTeamMailboxConsumption"],
            [38, "ProjectTeamReviewCompletionProposals"],
            [39, "ProjectTeamMailboxTurns"],
          ]);
          const upgradedSql = yield* SqlClient.SqlClient;
          expect(
            (yield* upgradedSql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id='created'`)[0]
              ?.revokedAt,
          ).toBeNull();
          const f = yield* seedTeam("implementer", "running", { issueCredential: false });
          expect(
            (yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id='created'`)[0]
              ?.revokedAt,
          ).not.toBeNull();
          yield* insertBindingSession("invalid", "agent:mcp:pi:forged-thread");
          expect(
            (yield* f
              .change(decodeRecord({ ...f.binding, revision: 1, threadId: "forged-thread" }))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* insertBindingSession("retired");
          const state = applyProjectWorkEvents(
            emptyProjectWorkReducerState(f.binding.projectId),
            yield* f.repo.replay(f.binding.projectId),
          );
          const task = state.tasks.find((entry) => entry.taskId === f.binding.taskId)!;
          yield* f.repo.execute({
            type: "project-work.foundation.commit",
            projectId: f.binding.projectId,
            commandId: CommandId.make("pause-original-assignment"),
            expectedRevision: state.revision,
            attribution: {
              actor: { kind: "human", id: "maintainer" },
              source: { kind: "web", id: "withdrawal-client" },
              recordedAt: at,
            },
            records: [],
            committedAt: at,
            guided: {
              intent: {
                type: "project-team.task.control",
                projectId: f.binding.projectId,
                taskId: task.taskId,
                commandId: CommandId.make("pause-original-assignment"),
                expectedRevision: state.revision,
                expectedTaskRevision: task.revision,
                control: { action: "pause", reason: "Human stops the original assignment" },
              },
            },
          });
          expect(
            (yield* f.sql`SELECT status FROM project_team_run_binding WHERE record_id=${f.binding.recordId}`)[0]
              ?.status,
          ).toBe("stopping");
          expect(
            (yield* f.auth
              .issueCredential({
                providerInstanceId: f.binding.providerInstanceId,
                threadId: f.binding.threadId,
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* insertBindingSession("replacement", "agent:mcp:codex:replacement-thread");
          const replacement = yield* createManagedAssignment({
            taskId: ProjectWorkTaskId.make("replacement-task"),
            recordId: "replacement-binding",
            attemptId: "replacement-attempt",
            commandId: "replacement-dispatch",
            providerInstanceId: ProviderInstanceId.make("codex"),
            threadId: ThreadId.make("replacement-thread"),
            sessionId: "replacement-native-session",
            role: f.role,
            configuration: f.binding.configuration,
            status: "running",
          });
          expect(replacement.taskId).not.toBe(f.binding.taskId);
          expect(replacement.attemptId).not.toBe(f.binding.attemptId);
          const currentIdentity = {
            providerInstanceId: replacement.providerInstanceId,
            threadId: replacement.threadId,
          };
          expect((yield* f.auth.issueCredential(currentIdentity))?.credential).toMatchObject({
            bindingId: replacement.recordId,
            generation: replacement.generation,
          });
          yield* insertBindingSession("rebuild-only", "agent:mcp:codex:replacement-thread");
          yield* f.sql`DELETE FROM project_team_identity_fences WHERE provider_instance_id='codex'`;
          const projection = yield* ProjectWorkProjection;
          yield* projection.rebuild("authorization-project");
          expect(
            (yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id='rebuild-only'`)[0]
              ?.revokedAt,
          ).toBeNull();
          expect(yield* f.sql`SELECT * FROM project_team_identity_fences`).toEqual([
            { provider_instance_id: "pi", thread_id: "authorization-thread" },
          ]);
          yield* f.change(
            decodeRecord({
              ...replacement,
              revision: replacement.revision + 1,
            }),
          );
          yield* f.sql`DELETE FROM project_team_run_binding`;
          yield* f.sql`DELETE FROM project_work_events`;
          yield* f.sql`DELETE FROM project_work_reducer_checkpoints`;
        }).pipe(Effect.provide(database())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            id: string;
            revokedAt: string | null;
          }>`SELECT session_id AS id,revoked_at AS revokedAt FROM auth_sessions ORDER BY session_id`;
          expect(rows.map((row) => [row.id, row.revokedAt !== null])).toEqual([
            ["created", true],
            ["invalid", false],
            ["rebuild-only", true],
            ["replacement", true],
            ["retired", true],
          ]);
          expect(
            yield* sql`SELECT * FROM project_team_run_binding WHERE status='running'`,
          ).toHaveLength(0);
          const fresh = yield* TeamAuthorization.ProjectTeamAuthorization;
          for (const identity of [
            {
              providerInstanceId: ProviderInstanceId.make("pi"),
              threadId: ThreadId.make("authorization-thread"),
            },
            {
              providerInstanceId: ProviderInstanceId.make("codex"),
              threadId: ThreadId.make("replacement-thread"),
            },
          ]) {
            expect((yield* fresh.issueCredential(identity).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect(
              (yield* fresh
                .resolve({
                  actor: { kind: "agent", id: TeamAuthorization.managedActorId(identity) },
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(yield* fresh.hasManagedThread(identity.threadId)).toBe(true);
          }
          expect(
            yield* fresh.discover({
              providerInstanceId: ProviderInstanceId.make("codex"),
              threadId: ThreadId.make("authorization-thread"),
            }),
          ).toBeUndefined();
        }).pipe(Effect.provide(database())),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
