import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
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
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkProjection } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamContext, ProjectTeamContextError } from "./ProjectTeamContext.ts";
import * as Accounting from "./ProjectTeamModelAccounting.ts";
import { managedActorId } from "./ProjectTeamAuthorization.ts";
import type {
  PiModelRequestReservation,
  PiModelRequestSettlement,
} from "../provider/pi/PiModelBroker.ts";

const decodeRecord = Schema.decodeUnknownEffect(TeamRecordSchema);
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const makeFixture = (role: "implementer" | "integrator" = "implementer") =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const result = yield* seed(role, "reserved", {
      roleTools: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      toolIds: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
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
            projectWritableWorkers: 1,
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
const budgetFixture = Effect.gen(function* () {
  const f = yield* makeFixture();
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
