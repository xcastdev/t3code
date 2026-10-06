import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  EventId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  ProjectWorkCommand,
  ProjectTeamRecord as TeamRecordSchema,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkProjection } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamContext, ProjectTeamContextError } from "./ProjectTeamContext.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";
import * as Accounting from "./ProjectTeamModelAccounting.ts";
import { managedActorId } from "./ProjectTeamAuthorization.ts";
import type {
  PiModelRequestReservation,
  PiModelRequestSettlement,
} from "../provider/pi/PiModelBroker.ts";

const encodeRetainedEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCommand = Schema.decodeUnknownEffect(ProjectWorkCommand);
const decodeRecord = Schema.decodeUnknownEffect(TeamRecordSchema);
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const makeFixture = (
  role: "implementer" | "integrator" | "planner" | "reviewer" | "investigator" = "implementer",
  writableWorkers = 1,
  readonlyKind?: "planning" | "review" | "investigation",
) =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const result = yield* seed(role, "reserved", {
      roleTools: role === "integrator" || readonlyKind ? ["pi.read"] : ["pi.read", "pi.write"],
      toolIds: role === "integrator" || readonlyKind ? ["pi.read"] : ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (
            readonlyKind !== undefined &&
            readonlyKind !== "review" &&
            command.type === "project-work.foundation.commit" &&
            command.guided?.intent.type === "project-team.plan.propose"
          )
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Stop before first parent plan"),
            );
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Fixture retains the uncommitted claim"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (readonlyKind !== undefined) {
      let state = yield* readCurrentState(sql, projectId);
      const parent = state.tasks.find((task) => task.taskId === "authorization-task");
      const specGate = state.foundationRecords?.find(
        (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "specification",
      );
      const plan = state.foundationRecords?.find(
        (r) => r.kind === "plan-revision" && r.taskId === parent?.taskId,
      );
      const planGate = state.foundationRecords?.find(
        (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "plan",
      );
      if (!parent || specGate?.kind !== "gate")
        return yield* Effect.die("Missing real parent specification");
      const human = {
        actor: { kind: "human", id: "readonly-context-human" },
        source: { kind: "web", id: "readonly-context-browser" },
        recordedAt: at,
      } as const;
      const envelope = {
        projectId,
        taskId: parent.taskId,
        commandId: "readonly-context-grant",
        expectedRevision: state.revision,
        expectedTaskRevision: parent.revision,
      };
      yield* repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: envelope.commandId,
          expectedRevision: state.revision,
          attribution: human,
          committedAt: at,
          records: [],
          guided: {
            intent:
              readonlyKind === "investigation"
                ? {
                    ...envelope,
                    type: "project-team.investigation.start",
                    objective: "Investigate original bounded scope",
                    outputDescriptions: ["Sourced investigation findings"],
                  }
                : {
                    ...envelope,
                    type: "project-team.assignment.start",
                    assignmentKind: readonlyKind,
                    objective:
                      readonlyKind === "planning"
                        ? "Draft the first approved plan"
                        : "Review original approved scope",
                    outputDescriptions: [
                      readonlyKind === "planning"
                        ? "Proposed first plan"
                        : "Independent review findings",
                    ],
                    specRevision: parent.specRevision,
                    specificationGateId: specGate.recordId,
                    expectedSpecificationGateRevision: specGate.revision,
                    ...(readonlyKind === "review" &&
                    plan?.kind === "plan-revision" &&
                    planGate?.kind === "gate"
                      ? {
                          parentPlan: {
                            recordId: plan.recordId,
                            expectedRecordRevision: plan.revision,
                            planRevision: plan.planRevision,
                            gateId: planGate.recordId,
                            expectedGateRevision: planGate.revision,
                          },
                        }
                      : {}),
                  },
          },
        }),
      );
      state = yield* readCurrentState(sql, projectId);
      const grant = state.foundationRecords?.find(
        (r) =>
          r.kind === "gate" &&
          r.taskId !== parent.taskId &&
          (r.gate === "assignment" || r.gate === "investigation"),
      );
      const task = state.tasks.find(
        (task) => task.taskId === (grant?.kind === "gate" ? grant.taskId : undefined),
      );
      const roleRecord = state.foundationRecords?.find(
        (r) => r.kind === "role-revision" && r.recordId === "role",
      );
      if (!task || grant?.kind !== "gate" || roleRecord?.kind !== "role-revision")
        return yield* Effect.die("Missing real readonly child grant");
      const binding = {
        kind: "run-binding",
        projectId,
        recordId: "binding",
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "reserved",
        taskId: task.taskId,
        attemptId: "attempt",
        memberId: "member",
        roleRevisionId: roleRecord.recordId,
        providerInstanceId: ProviderInstanceId.make("pi"),
        threadId: ThreadId.make("authorization-thread"),
        environmentId: "environment",
        model: roleRecord.model,
        configuration: {
          instructionsHash: "hash",
          toolIds: ["pi.read"],
          skillIds: [],
          runtimeVersion: "test",
          maxTokens: 1000,
          maxDurationMs: 1000,
          paidFallback: false,
        },
        worktree: "/workspace",
        branch: "task",
        leaseGeneration: 0,
        specRevision: task.specRevision,
        planRevision: 0,
        authorizationGateId: grant.recordId,
        scopeHash: projectTeamScopeHash(state, task.taskId),
      };
      pending = yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "readonly-context-claim",
        expectedRevision: state.revision,
        attribution,
        committedAt: at,
        records: [],
        transition: {
          kind: "claim",
          taskId: task.taskId,
          expectedTaskRevision: task.revision,
          authorizationGateId: grant.recordId,
          expectedGateRevision: grant.revision,
          binding,
          claim: {
            type: "project-work.task.claim",
            projectId,
            taskId: task.taskId,
            commandId: "readonly-context-claim",
            attemptId: "attempt",
            leaseToken: "readonly-context-lease",
            leasedUntil: "2030-01-01T00:00:00.000Z",
            claimedAt: at,
          },
        },
      });
    }
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Fixture did not capture its claim");
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "configure-limits",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records: [
          {
            kind: "limits",
            projectId,
            recordId: "limits",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "configured",
            environmentModelCalls: 4,
            projectWritableWorkers: writableWorkers,
            modelCalls: 2,
            delegationDepth: 2,
            repairAllowance: 2,
            model: "test",
            tokenLimit: 2000,
            durationLimitMs: 2000,
          },
        ],
      }),
    );
    yield* TestClock.setTime(Date.parse(at) + 1);
    const claim = {
      ...pending,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          branch: "refs/heads/assigned",
          worktree: "/workspace-assigned",
        },
      },
    };
    const request: ProjectTeamDispatchRequest = {
      dispatchId: "dispatch-intent",
      claim,
      git: {
        effectId: "dispatch-intent",
        runId: "binding",
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: "/workspace-assigned",
        branchRef: "refs/heads/assigned",
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: "setup",
      initializeOperationId: "initialize",
      assignmentOperationId: "assignment",
      assignment: "Implement the approved task",
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const reserved = yield* journal.reserve(request);
    const snapshot = yield* journal.claimEffect(reserved.fence);
    const reader = yield* makeProjectTeamContext({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const change = Effect.fn("contextFixture.change")(function* (record: ProjectTeamRecord) {
      yield* repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "change-" + record.recordId + "-" + record.revision,
          expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
          attribution,
          committedAt: at,
          records: [record],
        }),
      );
    });
    return { sql, repository, request, journal, snapshot, reader, change };
  });

const denied = Effect.fn("contextFixture.denied")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const result = yield* effect.pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ProjectTeamContextError);
});
const makeBudgetFixture = (writableWorkers = 1) =>
  Effect.gen(function* () {
    const f = yield* makeFixture("implementer", writableWorkers);
    const claim = f.snapshot.intent.compiledClaim.transition;
    if (claim?.kind !== "claim") return yield* Effect.die("Fixture claim missing");
    const binding = { ...claim.binding, status: "running" as const, revision: 1 };
    yield* f.change(binding);
    const managed = {
      projectId,
      bindingId: binding.recordId,
      generation: binding.generation,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
    };
    const principal = { actor: { kind: "agent" as const, id: managedActorId(managed) }, managed };
    const accounting = yield* Accounting.make({
      environmentId: "environment",
      routeId: "configured",
      model: "test",
      acceptedReportedModels: ["test"],
      resolveOperation: (_authority, reservation) =>
        Effect.succeed({
          workerId: reservation.workerId,
          operationId: reservation.operationId,
          rootTaskId: f.snapshot.intent.limits.rootTaskId,
          maximumTokens: f.snapshot.intent.limits.maximumTokens,
          deadlineAtMs: f.snapshot.intent.limits.rootDeadlineAtMs,
          operationMaximumTokens: f.snapshot.intent.limits.attemptMaximumTokens,
          operationDeadlineAtMs: f.snapshot.intent.limits.deadlineAtMs,
        }),
    });
    const reservation = (requestId: number): PiModelRequestReservation => ({
      workerId: "worker",
      generation: binding.generation,
      operationId: "assignment",
      requestId,
      routeId: "configured",
      provider: "command-code",
      model: "test",
      maxInputTokens: 100,
      maxOutputTokens: 100,
      callCount: 1,
      deadlineAtMs: f.snapshot.intent.limits.deadlineAtMs,
    });
    const reserve = (id: number) => accounting.reserve(principal, reservation(id));
    const settle = (
      reservationId: string,
      id: number,
      outcome: "reported" | "failed" | "unknown",
      drained = true,
    ) => {
      const value: PiModelRequestSettlement = {
        ...reservation(id),
        reservationId,
        transportDrained: drained,
        outcome,
        chargedInputTokens: outcome === "reported" ? 10 : 100,
        chargedOutputTokens: outcome === "reported" ? 20 : 100,
        ...(outcome === "reported"
          ? {
              reportedModel: "test",
              reportedUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }
          : {}),
      };
      return accounting.settle(value);
    };
    return { ...f, reserve, settle, reservation, accounting };
  });

const budgetFixture = makeBudgetFixture();

for (const kind of ["planning", "review", "investigation"] as const)
  it.effect(`required context reconstructs legal planless ${kind} original authority`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(
          kind === "planning" ? "planner" : kind === "review" ? "reviewer" : "investigator",
          1,
          kind,
        );
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing readonly original claim");
        expect(claim.binding.planRevision).toBe(0);
        const state = yield* readCurrentState(f.sql, projectId);
        expect(
          state.foundationRecords?.filter(
            (record) => record.kind === "plan-revision" && record.taskId === claim.binding.taskId,
          ),
        ).toEqual([]);
        const grant = state.foundationRecords?.find(
          (record) => record.recordId === claim.binding.authorizationGateId,
        );
        expect(grant).toMatchObject({
          kind: "gate",
          gate: kind === "investigation" ? "investigation" : "assignment",
          status: "consumed",
          attribution: { actor: { kind: "human" } },
        });
        const required = yield* f.reader.readForOperation({
          projectId,
          bindingId: claim.binding.recordId,
          generation: claim.binding.generation,
          providerInstanceId: claim.binding.providerInstanceId,
          threadId: claim.binding.threadId,
          operationId: f.request.initializeOperationId,
          operationKind: "initialize",
        });
        expect(required.required.tasks[0]?.plan).toBeUndefined();
        expect(required.required.tasks[0]?.criteria[0]?.description).toBe(
          kind === "planning"
            ? "Proposed first plan"
            : kind === "review"
              ? "Independent review findings"
              : "Sourced investigation findings",
        );
        expect(required.required.tasks[1]?.task.taskId).toBe("authorization-task");
        expect(required.required.approvals).toContainEqual(
          expect.objectContaining({ recordId: claim.binding.authorizationGateId }),
        );
      }),
    ),
  );

it.effect("required context denies actual duplicate equal plan revisions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const plan = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
        (record) => record.kind === "plan-revision",
      );
      if (plan?.kind !== "plan-revision") return yield* Effect.die("Missing original plan");
      yield* f.change({ ...plan, recordId: "duplicate-equal-plan" });
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.filter(
          (record) => record.kind === "plan-revision" && record.planRevision === plan.planRevision,
        ),
      ).toHaveLength(2);
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

for (const operationKind of ["initialize", "prompt"] as const)
  it.effect(`required operation lookup resolves exact original ${operationKind} context`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
        const resolved = yield* f.reader.readForOperation({
          projectId,
          bindingId: claim.binding.recordId,
          generation: claim.binding.generation,
          providerInstanceId: claim.binding.providerInstanceId,
          threadId: claim.binding.threadId,
          operationId:
            operationKind === "initialize"
              ? f.request.initializeOperationId
              : f.request.assignmentOperationId,
          operationKind,
        });
        expect(resolved).toEqual(yield* f.reader.readRequired(f.snapshot));
      }),
    ),
  );

for (const mismatch of [
  "project",
  "binding",
  "generation",
  "provider",
  "thread",
  "operation",
  "kind",
  "missing",
  "corrupt",
  "transaction",
] as const)
  it.effect(`required operation lookup denies ${mismatch} before delivering context`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing claim");
        const input = {
          projectId: mismatch === "project" ? "foreign-project" : projectId,
          bindingId: mismatch === "binding" ? "foreign-binding" : claim.binding.recordId,
          generation:
            mismatch === "generation" ? claim.binding.generation + 1 : claim.binding.generation,
          providerInstanceId:
            mismatch === "provider"
              ? ProviderInstanceId.make("foreign-provider")
              : claim.binding.providerInstanceId,
          threadId:
            mismatch === "thread" ? ThreadId.make("foreign-thread") : claim.binding.threadId,
          operationId:
            mismatch === "operation" ? "foreign-operation" : f.request.initializeOperationId,
          operationKind: mismatch === "kind" ? ("prompt" as const) : ("initialize" as const),
        };
        if (mismatch === "missing") yield* f.sql`DELETE FROM project_team_dispatch`;
        if (mismatch === "corrupt") {
          yield* f.sql`DROP TRIGGER project_team_dispatch_immutable`;
          yield* f.sql`UPDATE project_team_dispatch SET intent_json='{}'`;
        }
        if (mismatch === "transaction") {
          yield* f.sql`DROP TABLE project_team_dispatch`;
          const result = yield* f.sql
            .withTransaction(f.reader.readForOperation(input))
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "Required context must own its read transaction" },
          });
        } else yield* denied(f.reader.readForOperation(input));
      }),
    ),
  );

for (const count of [2, 129])
  it.effect(`required operation lookup denies ${count} ambiguous retained dispatches`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing original claim");
        // Corrupt duplicate rows cannot occur through journal writes; exercise denial against retained SQL corruption.
        yield* f.sql`ALTER TABLE project_team_dispatch RENAME TO original_context_dispatch`;
        yield* f.sql`CREATE TABLE project_team_dispatch AS SELECT * FROM original_context_dispatch WHERE 0`;
        for (let i = 0; i < count; i++)
          yield* f.sql`INSERT INTO project_team_dispatch SELECT * FROM original_context_dispatch`;
        yield* denied(
          f.reader.readForOperation({
            projectId,
            bindingId: claim.binding.recordId,
            generation: claim.binding.generation,
            providerInstanceId: claim.binding.providerInstanceId,
            threadId: claim.binding.threadId,
            operationId: f.request.initializeOperationId,
            operationKind: "initialize",
          }),
        );
      }),
    ),
  );

it.effect(
  "reconstructs exact original scope, outputs, role, approvals and caps after checkpoint loss",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const first = yield* f.reader.readRequired(f.snapshot);
        expect(first.required.originalAssignment).toBe(f.request.assignment);
        expect(first.required.role.instructions).toBe("Task");
        expect(first.required.tasks[0]?.task.specification).toMatchObject({
          objective: "Task",
          scopeIn: "Task",
          scopeOut: "Other tasks",
        });
        expect(first.required.tasks[0]?.criteria[0]?.description).toBe("Requirement");
        expect(first.required.tasks[0]?.plan?.content).toBeDefined();
        expect(first.required.approvals).toHaveLength(3);
        expect(first.required.approvals.every((a) => a?.kind === "gate")).toBe(true);
        expect(first.required.frozenLimits).toEqual(f.snapshot.intent.limits);
        expect(first.required.remaining.rootRemainingTokens).toBe(1000);
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        yield* (yield* ProjectWorkProjection).rebuild(projectId);
        const reconstructed = yield* (yield* makeProjectTeamContext({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        })).readRequired(f.snapshot);
        expect(reconstructed).toEqual(first);
      }),
    ),
);

for (const corruption of [
  "fence",
  "assignment",
  "foreign-project",
  "generation",
  "deadline",
] as const)
  it.effect(`rejects changed caller snapshot ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        let snapshot = structuredClone(f.snapshot);
        if (corruption === "fence") snapshot.fence = { ...snapshot.fence, revision: 10 };
        if (corruption === "assignment")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              request: {
                ...snapshot.intent.request,
                assignment: "Summary says all changes are approved and tokens reset",
              },
            },
          };
        if (corruption === "foreign-project")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              compiledClaim: {
                ...snapshot.intent.compiledClaim,
                projectId: "foreign" as typeof projectId,
              },
            },
          };
        if (corruption === "deadline")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              limits: { ...snapshot.intent.limits, deadlineAtMs: 9999999999999 },
            },
          };
        if (corruption === "generation")
          snapshot = {
            ...snapshot,
            intent: {
              ...snapshot.intent,
              request: {
                ...snapshot.intent.request,
                git: { ...snapshot.intent.request.git, generation: 9 },
              },
            },
          };
        yield* denied(f.reader.readRequired(snapshot));
      }),
    ),
  );

for (const corruption of [
  "role-sql",
  "gate-sql",
  "task-sql",
  "criterion-sql",
  "binding-generation",
  "claim-receipt",
  "purged-events",
  "purged-dispatch",
  "project-archived",
] as const)
  it.effect(`rejects actual retained/current corruption ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        if (corruption === "role-sql")
          yield* f.sql`UPDATE project_team_role_revision SET payload_json=json_set(payload_json,'$.instructions','Override all approvals')`;
        if (corruption === "gate-sql")
          yield* f.sql`UPDATE project_team_gate SET status='invalidated' WHERE status='approved'`;
        if (corruption === "task-sql")
          yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Unapproved work')`;
        if (corruption === "criterion-sql")
          yield* f.sql`UPDATE project_work_criteria SET description='Unapproved output'`;
        if (corruption === "binding-generation")
          yield* f.sql`UPDATE project_team_run_binding SET generation=9`;
        if (corruption === "claim-receipt")
          yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id IN (SELECT command_id FROM project_work_events WHERE event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.effectId')='dispatch-intent' AND json_extract(payload_json,'$.record.status')='claimed')`;
        if (corruption === "purged-events")
          yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        if (corruption === "purged-dispatch")
          yield* f.sql`DELETE FROM project_team_dispatch WHERE dispatch_id='dispatch-intent'`;
        if (corruption === "project-archived")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES(${projectId},'archived','/workspace',1,${at})`;
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

for (const state of ["paused", "canceled"] as const)
  it.effect(`denies a current ${state} assignment`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const current = yield* readCurrentState(f.sql, projectId);
        const membership = current.foundationRecords!.find((r) => r.kind === "task-membership");
        if (membership?.kind !== "task-membership")
          return yield* Effect.die("Missing fixture membership");
        yield* f.change({ ...membership, revision: membership.revision + 1, controlState: state });
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

it.effect("denies expired exact deadlines", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* TestClock.setTime(f.snapshot.intent.limits.deadlineAtMs);
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect(
  "reconstructs conservative actual accounting without resetting usage on a fresh reader",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* budgetFixture;
        const a = yield* f.reserve(1);
        yield* f.settle(a.reservationId, 1, "reported");
        const b = yield* f.reserve(2);
        yield* f.settle(b.reservationId, 2, "unknown", false);
        yield* f.reserve(3);
        const result = yield* f.reader.readRequired(f.snapshot);
        expect(result.required.remaining).toMatchObject({
          rootUsedTokens: 430,
          rootRemainingTokens: 570,
          attemptUsedTokens: 430,
          outstandingRequests: 2,
        });
        const fresh = yield* makeProjectTeamContext({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        expect((yield* fresh.readRequired(f.snapshot)).required.remaining).toEqual(
          result.required.remaining,
        );
        expect(result.required.frozenLimits.attemptMaximumTokens).toBe(1000);
      }),
    ),
);

for (const corruption of [
  "wrong-root",
  "reservation-json",
  "wrong-generation",
  "released-zero-charge",
  "settlement-json",
  "legacy-capacity",
  "frozen-budget",
] as const)
  it.effect(`denies actual model ledger corruption ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* budgetFixture;
        const r = yield* f.reserve(1);
        yield* f.settle(r.reservationId, 1, "unknown");
        if (corruption === "wrong-root") {
          yield* f.sql`INSERT INTO project_team_model_budget VALUES('environment',${projectId},'foreign-root',1000,${f.snapshot.intent.limits.rootDeadlineAtMs})`;
          yield* f.sql`UPDATE project_team_model_request SET root_task_id='foreign-root'`;
        }
        if (corruption === "reservation-json")
          yield* f.sql`UPDATE project_team_model_request SET reservation_json=json_set(reservation_json,'$.maxInputTokens',1)`;
        if (corruption === "wrong-generation")
          yield* f.sql`UPDATE project_team_model_request SET generation=1`;
        if (corruption === "released-zero-charge")
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=0,charged_output_tokens=0`;
        if (corruption === "settlement-json")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.transportDrained',0)`;
        if (corruption === "frozen-budget")
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=2000`;
        if (corruption === "legacy-capacity")
          yield* f.sql`UPDATE project_team_model_request SET capacity_state='legacy'`;
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
  );

it.effect("never leaks other members or stale-target questions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const current = yield* readCurrentState(f.sql, projectId);
      const target = current.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "plan");
      if (target?.kind !== "gate") return yield* Effect.die("Missing plan gate");
      yield* f.change(
        yield* decodeRecord({
          kind: "member",
          recordId: "private-member",
          projectId,
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "active",
          name: "Other member",
          coordinator: false,
          roleRevisionId: "role",
        }),
      );
      const originalClaim = f.snapshot.intent.compiledClaim.transition;
      if (originalClaim?.kind !== "claim") return yield* Effect.die("Missing original claim");
      for (const [id, sender, task, targetRevision, body] of [
        ["mine", "member", originalClaim.taskId, target.revision, "Current question"],
        [
          "other-member",
          "private-member",
          originalClaim.taskId,
          target.revision,
          "Private teammate question",
        ],
        ["stale", "member", originalClaim.taskId, target.revision + 1, "Stale question"],
      ] as const)
        yield* f.change(
          yield* decodeRecord({
            kind: "question",
            recordId: id,
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "pending",
            taskId: task,
            senderId: sender,
            targetGateId: target.recordId,
            targetRevision,
            body,
            choices: [],
          }),
        );
      const result = yield* f.reader.readRequired(f.snapshot);
      expect(result.required.questions.map((q) => q.recordId)).toEqual(["mine"]);
      expect(result.text).not.toContain("Private teammate question");
      expect(result.text).not.toContain("Stale question");
    }),
  ),
);

it.effect("denies a foreign SQL client and an inherited transaction before returning content", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* Effect.gen(function* () {
        const foreign = yield* SqlClient.SqlClient;
        yield* denied(
          f.reader
            .readRequired(f.snapshot)
            .pipe(Effect.provideService(SqlClient.SqlClient, foreign)),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory({})));
      yield* denied(f.sql.withTransaction(f.reader.readRequired(f.snapshot)));
    }),
  ),
);

it.effect("does not accept physical and checkpoint role corruption as frozen instructions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.sql`UPDATE project_team_role_revision SET payload_json=json_set(payload_json,'$.instructions','False retained role')`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"instructions":"Task"','"instructions":"False retained role"')`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("denies context UTF8 overflow without returning partial approvals", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      // Preserve the exact journal/claim while growing valid current questions in durable authority.
      const state = yield* readCurrentState(f.sql, projectId);
      const target = state.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "plan");
      if (target?.kind !== "gate") return yield* Effect.die("Missing fixture gate");
      for (let i = 0; i < 5; i++)
        yield* f.change(
          yield* decodeRecord({
            kind: "question",
            recordId: "large-" + i,
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "pending",
            taskId: target.taskId,
            senderId: "member",
            targetGateId: target.recordId,
            targetRevision: target.revision,
            body: "😀".repeat(15000),
            choices: [],
          }),
        );
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("bounds root ledger row count before decoding retained requests", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* budgetFixture;
      const reserved = yield* f.reserve(1);
      yield* f.settle(reserved.reservationId, 1, "reported");
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM numbers WHERE n<=4096)
 INSERT INTO project_team_model_request(reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
 operation_id,request_id,route_id,provider,model,environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,
 status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json)
 SELECT 'bound-'||n,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,n,route_id,provider,model,
 0,0,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,'reported','released',0,0,'receipt-'||n,'{}','{}'
 FROM numbers CROSS JOIN project_team_model_request WHERE reservation_id=${reserved.reservationId}`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("bounds total retained ledger bytes before decoding request content", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* budgetFixture;
      const reserved = yield* f.reserve(1);
      yield* f.settle(reserved.reservationId, 1, "reported");
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM numbers WHERE n<1026)
    INSERT INTO project_team_model_request(reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
    operation_id,request_id,route_id,provider,model,environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,
    status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json)
    SELECT 'byte-bound-'||n,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,n,route_id,provider,model,
    0,0,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,'reported','released',0,0,'receipt-'||n,'{}',printf('%16384s','')
    FROM numbers CROSS JOIN project_team_model_request WHERE reservation_id=${reserved.reservationId}`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect(
  "denies coordinated checkpoint and task scope corruption against retained approval history",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.sql`UPDATE project_work_tasks SET specification_json=replace(specification_json,'"scopeIn":"Task"','"scopeIn":"False approved scope"')`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"scopeIn":"Task"','"scopeIn":"False approved scope"')`;
        expect(
          (yield* f.sql<{
            scope: string;
          }>`SELECT json_extract(specification_json,'$.scopeIn') AS scope FROM project_work_tasks`)[0]
            ?.scope,
        ).toBe("False approved scope");
        expect((yield* readCurrentState(f.sql, projectId)).tasks[0]?.specification?.scopeIn).toBe(
          "False approved scope",
        );
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect(
  "denies coordinated checkpoint and required criterion corruption against original gate content",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.sql`UPDATE project_work_criteria SET description='False approved output'`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"description":"Requirement"','"description":"False approved output"')`;
        expect(
          (yield* f.sql<{ description: string }>`SELECT description FROM project_work_criteria`)[0]
            ?.description,
        ).toBe("False approved output");
        expect((yield* readCurrentState(f.sql, projectId)).criteria[0]?.description).toBe(
          "False approved output",
        );
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect(
  "denies coordinated criterion completion corruption without retained completion evidence",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.sql`UPDATE project_work_criteria SET status='satisfied'`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,'"status":"unsatisfied"','"status":"satisfied"')`;
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_work_criteria`)[0]?.status,
        ).toBe("satisfied");
        expect((yield* readCurrentState(f.sql, projectId)).criteria[0]?.status).toBe("satisfied");
        yield* f.journal.inspect(f.snapshot.fence.dispatchId, { requireClaim: true });
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

it.effect("accepts exact retained typed criterion progress after actual projection replay", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const state = yield* readCurrentState(f.sql, projectId);
      const criterion = state.criteria[0];
      if (criterion === undefined) return yield* Effect.die("Missing fixture criterion");
      // Restore an actual historical event shape; no worker receipt or new approval is minted.
      const event: ProjectWorkEvent = {
        eventId: EventId.make("retained-criterion-progress"),
        projectId,
        revision: state.revision + 1,
        occurredAt: at,
        type: "project-work.criterion.upserted",
        taskId: criterion.taskId,
        criterion: {
          ...criterion,
          status: "satisfied",
          revision: criterion.revision + 1,
          updatedAt: at,
        },
        updatedAt: at,
      };
      const payload = yield* encodeRetainedEvent(event);
      yield* f.sql`INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    VALUES(${event.eventId},${projectId},${event.type},${at},'retained-progress-fixture',${payload})`;
      yield* (yield* ProjectWorkProjection).rebuild(projectId);
      const result = yield* f.reader.readRequired(f.snapshot);
      expect(result.required.tasks[0]?.criteria[0]).toEqual(event.criterion);
      expect(result.provenance.criterionEventIds).toContain(event.eventId);
      expect(result.required.frozenLimits).toEqual(f.snapshot.intent.limits);
    }),
  ),
);

it.effect("denies malformed retained criterion progress despite agreeing derived copies", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.criterion.status','invented')
    WHERE project_id=${projectId} AND event_type='project-work.criterion.upserted'`;
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect("keeps unrelated project history outside required criterion bounds and content", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const before = yield* f.reader.readRequired(f.snapshot);
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<4097)
    INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    SELECT 'foreign-history-'||n,'foreign-project','project-work.criterion.upserted',${at},'foreign-command-'||n,'{}' FROM numbers`;
      expect(yield* f.reader.readRequired(f.snapshot)).toEqual(before);
    }),
  ),
);

it.effect("bounds retained criterion history before decoding completion payloads", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const claim = f.snapshot.intent.compiledClaim.transition;
      if (claim?.kind !== "claim") return yield* Effect.die("Missing fixture claim");
      yield* f.sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<4097)
    INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    SELECT 'criterion-bound-'||n,${projectId},'project-work.task.completed',${at},'criterion-command-'||n,
      json_object('eventId','criterion-bound-'||n,'projectId',${projectId},'type','project-work.task.completed','taskId',${claim.taskId}) FROM numbers`;
      // Corrupt the checkpoint's cursor so current derived authority cannot expose the tail itself.
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET last_sequence=(SELECT max(sequence) FROM project_work_events WHERE project_id=${projectId}) WHERE project_id=${projectId}`;
      yield* f.journal.inspect(f.snapshot.fence.dispatchId, { requireClaim: true });
      yield* denied(f.reader.readRequired(f.snapshot));
    }),
  ),
);

it.effect(
  "preserves actual initial-upsert timestamp semantics and denies an unsupported derived timestamp",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const older = "2025-12-31T00:00:00.000Z";
        yield* f.repository.execute(
          yield* decodeCommand({
            type: "project-work.task.create",
            projectId,
            commandId: "timestamp-legacy-task",
            taskId: "timestamp-task",
            title: "Legacy timestamp control",
            createdAt: at,
          }),
        );
        yield* f.repository.execute(
          yield* decodeCommand({
            type: "project-work.criterion.upsert",
            projectId,
            commandId: "timestamp-legacy-criterion",
            taskId: "timestamp-task",
            updatedAt: at,
            criterion: {
              criterionId: "timestamp-criterion",
              taskId: "timestamp-task",
              description: "Legacy output",
              required: true,
              status: "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: older,
            },
          }),
        );
        const events = yield* f.repository.replay(projectId);
        const produced = events.find(
          (e) =>
            e.type === "project-work.criterion.upserted" &&
            e.criterion.criterionId === "timestamp-criterion",
        );
        const original = events.find(
          (e) =>
            e.type === "project-work.criterion.upserted" &&
            e.criterion.criterionId !== "timestamp-criterion",
        );
        if (
          produced?.type !== "project-work.criterion.upserted" ||
          original?.type !== "project-work.criterion.upserted"
        )
          return yield* Effect.die("Missing actual timestamp producer events");
        expect(produced.updatedAt).toBe(at);
        expect(produced.criterion.updatedAt).toBe(older);
        // Restore that verified initial-upsert date relationship to the original retained criterion.
        const restored = {
          ...original,
          criterion: { ...original.criterion, updatedAt: produced.criterion.updatedAt },
        };
        const payload = yield* encodeRetainedEvent(restored);
        yield* f.sql`UPDATE project_work_events SET payload_json=${payload} WHERE event_id=${original.eventId}`;
        yield* (yield* ProjectWorkProjection).rebuild(projectId);
        expect(
          (yield* f.reader.readRequired(f.snapshot)).required.tasks[0]?.criteria[0]?.updatedAt,
        ).toBe(older);
        yield* f.sql`UPDATE project_work_criteria SET updated_at=${at} WHERE criterion_id=${original.criterion.criterionId}`;
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=replace(state_json,${older},${at}) WHERE project_id=${projectId}`;
        yield* f.journal.inspect(f.snapshot.fence.dispatchId, { requireClaim: true });
        yield* denied(f.reader.readRequired(f.snapshot));
      }),
    ),
);

const lineageFixture = Effect.gen(function* () {
  const f = yield* makeBudgetFixture(2);
  const a = yield* f.reserve(1);
  yield* f.settle(a.reservationId, 1, "reported");
  const state = yield* readCurrentState(f.sql, projectId);
  const limits = state.foundationRecords!.find((r) => r.kind === "limits")!;
  if (limits.kind !== "limits") return yield* Effect.die("Missing limits");
  yield* f.change({ ...limits, revision: limits.revision + 1, projectWritableWorkers: 2 });
  const role = state.foundationRecords!.find((r) => r.kind === "role-revision")!;
  const oldClaim = f.snapshot.intent.compiledClaim.transition;
  if (role.kind !== "role-revision" || oldClaim?.kind !== "claim")
    return yield* Effect.die("Missing role/claim");
  yield* f.repository.execute(
    yield* decodeCommand({
      type: "project-work.task.create",
      projectId,
      taskId: "sibling-task",
      commandId: "sibling-create",
      title: "Sibling",
      createdAt: at,
    }),
  );
  yield* f.change(
    yield* decodeRecord({
      kind: "task-membership",
      projectId,
      recordId: "sibling-membership",
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "active",
      taskId: "sibling-task",
      executionKind: "managed",
      deliverableKind: "code",
      controlState: "active",
      parentTaskId: oldClaim.binding.taskId,
    }),
  );
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  yield* createManagedAssignment({
    taskId: ProjectWorkTaskId.make("sibling-task"),
    recordId: "sibling-binding",
    attemptId: "sibling-attempt",
    commandId: "sibling-dispatch",
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("sibling-thread"),
    role,
    status: "reserved",
    configuration: oldClaim.binding.configuration,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...f.repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          pending = command;
          return Effect.fail(
            new ProjectWorkPolicyError("invalid-state", "Control captures second claim"),
          );
        }
        return f.repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Second claim not captured");
  const nextState = yield* readCurrentState(f.sql, projectId);
  const membership = nextState.foundationRecords!.find(
    (r) => r.kind === "task-membership" && r.taskId === "sibling-task",
  )!;
  if (membership.kind !== "task-membership") return yield* Effect.die("Missing sibling membership");
  expect(membership.parentTaskId).toBe(oldClaim.binding.taskId);
  const request: ProjectTeamDispatchRequest = {
    ...f.request,
    dispatchId: "sibling-dispatch",
    claim: {
      ...pending,
      expectedRevision: (yield* readCurrentState(f.sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          branch: "refs/heads/sibling",
          worktree: "/sibling-worktree",
        },
      },
    },
    git: {
      ...f.request.git,
      effectId: "sibling-dispatch",
      runId: "sibling-binding",
      branchRef: "refs/heads/sibling",
      worktreePath: "/sibling-worktree",
      ownershipToken: "sibling-owner",
    },
    setupId: "sibling-setup",
    initializeOperationId: "sibling-init",
    assignmentOperationId: "sibling-assignment",
  };
  const next = yield* f.journal.claimEffect((yield* f.journal.reserve(request)).fence);
  return { ...f, next, a };
});

it.effect(
  "denies historical owner loss with a relocated charge and accepts exact restoration",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* lineageFixture;
        const before = yield* f.reader.readRequired(f.next);
        expect(before.required.remaining).toMatchObject({
          rootUsedTokens: 30,
          rootRemainingTokens: 970,
        });
        const dispatch =
          (yield* f.sql`SELECT * FROM project_team_dispatch WHERE dispatch_id='dispatch-intent'`)[0]!;
        yield* f.sql`INSERT INTO project_team_model_budget SELECT environment_id,project_id,'moved-root',maximum_tokens,deadline_at_ms FROM project_team_model_budget`;
        yield* f.sql`UPDATE project_team_model_request SET root_task_id='moved-root' WHERE reservation_id=${f.a.reservationId}`;
        yield* denied(f.reader.readRequired(f.next));
        yield* f.sql`UPDATE project_team_model_request SET root_task_id=${f.snapshot.intent.limits.rootTaskId} WHERE reservation_id=${f.a.reservationId}`;
        expect(yield* f.reader.readRequired(f.next)).toEqual(before);
        yield* f.sql`DELETE FROM project_team_dispatch WHERE dispatch_id='dispatch-intent'`;
        yield* denied(f.reader.readRequired(f.next));
        yield* f.sql`UPDATE project_team_model_request SET root_task_id='moved-root' WHERE reservation_id=${f.a.reservationId}`;
        yield* f.journal.inspect(f.next.fence.dispatchId, { requireClaim: true });
        const altered = yield* f.reader.readRequired(f.next).pipe(Effect.result);
        yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert(dispatch)}`;
        yield* f.sql`UPDATE project_team_model_request SET root_task_id=${f.snapshot.intent.limits.rootTaskId} WHERE reservation_id=${f.a.reservationId}`;
        const restored = yield* f.reader.readRequired(f.next);
        expect(restored).toEqual(before);
        expect(altered._tag).toBe("Failure");
      }),
    ),
);

it.effect("denies unapproved ancestor scope despite agreeing physical and checkpoint copies", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* lineageFixture;
      const before = yield* f.reader.readRequired(f.next);
      expect(before.required.tasks[1]?.task.specification?.scopeIn).toBe("Task");
      const parentBefore = yield* f.reader.readRequired(f.snapshot);
      const retainedBefore =
        yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`;
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Unapproved ancestor scope') WHERE task_id='authorization-task'`;
      yield* denied(f.reader.readRequired(f.next));
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Task') WHERE task_id='authorization-task'`;
      expect(yield* f.reader.readRequired(f.next)).toEqual(before);
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Unapproved ancestor scope') WHERE project_id=${projectId}`;
      yield* denied(f.reader.readRequired(f.next));
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Task') WHERE project_id=${projectId}`;
      expect(yield* f.reader.readRequired(f.next)).toEqual(before);
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Unapproved ancestor scope') WHERE task_id='authorization-task'`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Unapproved ancestor scope') WHERE project_id=${projectId}`;
      const state = yield* readCurrentState(f.sql, projectId);
      expect(
        state.tasks.find((t) => t.taskId === "authorization-task")?.specification?.scopeIn,
      ).toBe("Unapproved ancestor scope");
      expect(
        yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`,
      ).toEqual(retainedBefore);
      yield* denied(f.reader.readRequired(f.snapshot));
      yield* f.journal.inspect(f.next.fence.dispatchId, { requireClaim: true });
      const result = yield* f.reader.readRequired(f.next).pipe(Effect.result);
      yield* f.sql`UPDATE project_work_tasks SET specification_json=json_set(specification_json,'$.scopeIn','Task') WHERE task_id='authorization-task'`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.tasks[0].specification.scopeIn','Task') WHERE project_id=${projectId}`;
      expect(yield* f.reader.readRequired(f.next)).toEqual(before);
      expect(yield* f.reader.readRequired(f.snapshot)).toEqual(parentBefore);
      expect(result._tag).toBe("Failure");
    }),
  ),
);
