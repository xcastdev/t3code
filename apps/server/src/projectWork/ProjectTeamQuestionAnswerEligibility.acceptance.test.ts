import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectWorkTaskId,
  ProjectWorkFoundationCommitCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  taskId,
  providerInstanceId,
  seed,
  createManagedAssignment,
  gatewayRuntime,
  decodeRecord,
  restoreHistoricalBinding,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { decideProjectWorkCommand } from "./ProjectWorkDecider.ts";
import { ProjectWorkProjection } from "./ProjectWorkProjection.ts";
import {
  deriveProjectWorkClaimPrerequisites,
  ProjectWorkPolicyError,
} from "./ProjectWorkPolicy.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamScheduler } from "./ProjectTeamScheduler.ts";
import { makeProjectTeamSchedulingView } from "./ProjectTeamSchedulingView.ts";
import { makeProjectTeamExecutionReactor } from "./ProjectTeamExecutionReactor.ts";
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { ProjectTeamAuthorization, managedActorId } from "./ProjectTeamAuthorization.ts";
import { layerTest } from "../serverSettings.ts";
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  yield* seed("implementer", "reserved", {
    roleTools: ["pi.read", "pi.write"],
    toolIds: ["pi.read", "pi.write"],
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
          return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain fixture claim"));
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Missing uncommitted claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "scheduler-limits",
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
          environmentModelCalls: 2,
          projectWritableWorkers: 1,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          taskPriorities: [{ taskId, priority: -1 }],
          model: "test",
          tokenLimit: 2000,
          durationLimitMs: 2000,
        },
      ],
    }),
  );
  yield* TestClock.setTime(Date.parse(at) + 1);
  const request: ProjectTeamDispatchRequest = {
    dispatchId: "scheduler-dispatch",
    claim: { ...pending, expectedRevision: (yield* readCurrentState(sql, projectId)).revision },
    git: {
      effectId: "scheduler-dispatch",
      runId: "binding",
      generation: 0,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: "/workspace",
      branchRef: "task",
      baseRef: "main",
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
    maximumEnvironmentModelCalls: 2,
  });
  return { sql, repository, request, journal };
});

it.effect(
  "a second device answer dispatches only a newly eligible task and survives scheduler restart without approval",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const gateway = yield* ProjectWorkGateway;
      const state = yield* readCurrentState(f.sql, projectId);
      const role = state.foundationRecords?.find((r) => r.kind === "role-revision");
      if (role?.kind !== "role-revision") return yield* Effect.die("Missing original role");
      const questionRole = decodeRecord({
        ...role,
        recordId: "question-role",
        roleId: "investigator",
        role: "investigator",
        tools: ["project-work.write"],
      });
      if (questionRole.kind !== "role-revision") return yield* Effect.die("Missing question role");
      yield* f.repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "question-role",
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [
            questionRole,
            decodeRecord({
              ...state.foundationRecords!.find((r) => r.kind === "member"),
              recordId: "question-member",
              roleRevisionId: questionRole.recordId,
            }),
          ],
        }),
      );
      const questionTask = ProjectWorkTaskId.make("question-task");
      const questionBinding = yield* createManagedAssignment({
        taskId: questionTask,
        recordId: "question-binding",
        attemptId: "question-attempt",
        commandId: "question-claim",
        providerInstanceId,
        threadId: ThreadId.make("question-thread"),
        role: questionRole,
        memberId: "question-member",
        status: "running",
        sessionId: "question-session",
        configuration: {
          instructionsHash: "hash",
          toolIds: ["project-work.write"],
          skillIds: [],
          runtimeVersion: "test",
          maxTokens: 1000,
          maxDurationMs: 1000,
          paidFallback: false,
        },
      });

      const auth = yield* ProjectTeamAuthorization;
      const issued = yield* auth.issueCredential({
        providerInstanceId,
        threadId: questionBinding.threadId,
      });
      if (issued === undefined) return yield* Effect.die("Question credential absent");
      const principal = {
        actor: { kind: "agent" as const, id: managedActorId(issued.credential) },
        managed: issued.credential,
      };
      const questionState = yield* readCurrentState(f.sql, projectId);
      const originalGate = questionState.foundationRecords?.find(
        (r) => r.kind === "gate" && r.recordId === questionBinding.planGateId,
      );
      if (originalGate?.kind !== "gate") return yield* Effect.die("Original question gate absent");
      yield* f.repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "pending-question-gate",
          expectedRevision: questionState.revision,
          attribution,
          committedAt: at,
          records: [
            decodeRecord({
              ...originalGate,
              recordId: "pending-human-gate",
              gate: "plan",
              status: "pending",
              revision: 0,
            }),
          ],
        }),
      );
      const askState = yield* readCurrentState(f.sql, projectId);
      const task = askState.tasks.find((t) => t.taskId === questionTask)!;
      const gate = askState.foundationRecords?.find(
        (r) => r.kind === "gate" && r.recordId === "pending-human-gate",
      );
      if (gate?.kind !== "gate") return yield* Effect.die("Question gate absent");
      yield* gateway.write(
        {
          type: "project-team.question.request",
          projectId,
          taskId: questionTask,
          commandId: CommandId.make("request-on-first-device"),
          expectedRevision: askState.revision,
          expectedTaskRevision: task.revision,
          specRevision: task.specRevision,
          planRevision: questionBinding.planRevision,
          questionId: "wake-question",
          targetGateId: gate.recordId,
          expectedGateRevision: gate.revision,
          body: "Which retained option?",
          choices: ["Keep", "Replace"],
        },
        principal.actor,
        { kind: "mcp", id: "first-device" },
        principal,
      );
      const requests = new Map([[taskId, f.request]]);
      for (const action of ["pause", "cancel", "gated", "stale"] as const) {
        const siblingTask = ProjectWorkTaskId.make(`${action}-task`);
        let siblingClaim: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
        yield* createManagedAssignment({
          taskId: siblingTask,
          recordId: `${action}-binding`,
          attemptId: `${action}-attempt`,
          commandId: `${action}-claim`,
          providerInstanceId,
          threadId: ThreadId.make(`${action}-thread`),
          role,
          status: "reserved",
          configuration: questionBinding.configuration,
        }).pipe(
          Effect.provideService(ProjectWorkRepository, {
            ...f.repository,
            execute: (command) => {
              if (
                command.type === "project-work.foundation.commit" &&
                command.transition?.kind === "claim"
              ) {
                siblingClaim = command;
                return Effect.fail(
                  new ProjectWorkPolicyError("invalid-state", "Retain unclaimed sibling"),
                );
              }
              return f.repository.execute(command);
            },
          }),
          Effect.result,
        );
        if (siblingClaim?.transition?.kind !== "claim")
          return yield* Effect.die("Missing sibling claim");
        requests.set(siblingTask, {
          ...f.request,
          dispatchId: `${action}-dispatch`,
          claim: siblingClaim,
          git: { ...f.request.git, effectId: `${action}-dispatch`, runId: `${action}-binding` },
          setupId: `${action}-setup`,
          initializeOperationId: `${action}-initialize`,
          assignmentOperationId: `${action}-assignment`,
        });
        const current = yield* readCurrentState(f.sql, projectId);
        if (action === "gated" || action === "stale") {
          const grant = current.foundationRecords?.find(
            (r) =>
              "taskId" in r &&
              r.taskId === siblingTask &&
              (action === "gated"
                ? r.kind === "gate" && r.gate === "execution"
                : r.kind === "plan-revision"),
          );
          if (grant?.kind !== "gate" && grant?.kind !== "plan-revision")
            return yield* Effect.die("Missing sibling authority");
          yield* restoreHistoricalBinding(
            decodeRecord({
              ...grant,
              revision: grant.revision + 1,
              ...(action === "gated"
                ? { status: "pending" }
                : { content: "Changed plan scope after authorization" }),
            }),
          );
          continue;
        }
        yield* gateway.write(
          {
            type: "project-team.task.control",
            projectId,
            taskId: siblingTask,
            commandId: CommandId.make(`control-${action}`),
            expectedRevision: current.revision,
            expectedTaskRevision: current.tasks.find((t) => t.taskId === siblingTask)!.revision,
            control: { action, reason: "Human steering before answer" },
          },
          { kind: "human", id: "maintainer" },
          { kind: "web", id: "first-device" },
        );
      }
      const view = yield* makeProjectTeamSchedulingView();
      // Only fixture request preparation is held during startup. Policy, selection,
      // gateway writes and journal reservation use their production implementations.
      let requestReady = false;
      const makeScheduler = (journal = f.journal) =>
        makeProjectTeamScheduler({
          environmentId: "environment",
          ports: {
            ...view,
            reserve: journal.reserve,
            prepareRequest: ({ state, taskId: selected }) => {
              const request = requests.get(selected);
              return request !== undefined && requestReady
                ? Effect.succeed({
                    _tag: "Prepared" as const,
                    request: {
                      ...request,
                      claim: { ...request.claim, expectedRevision: state.revision },
                    },
                  })
                : Effect.succeed({
                    _tag: "Blocked" as const,
                    reason: "Fixture request preparation not ready",
                  });
            },
          },
        });
      const scheduler = yield* makeScheduler();
      const sweeps = yield* Queue.unbounded<Effect.Success<ReturnType<typeof scheduler.sweep>>>();
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: Effect.succeed({
          ready: Effect.void,
          sweep: scheduler.sweep().pipe(
            Effect.flatMap((result) => Queue.offer(sweeps, result)),
            Effect.asVoid,
          ),
          stop: Effect.void,
        }),
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
      );
      yield* reactor.ready;
      expect((yield* Queue.take(sweeps)).committed).toEqual([]);
      const before = yield* readCurrentState(f.sql, projectId);
      requestReady = true;
      expect(deriveProjectWorkClaimPrerequisites(before, taskId).claimable).toBe(true);
      expect(() =>
        decideProjectWorkCommand(before, {
          ...f.request.claim,
          expectedRevision: before.revision,
        }),
      ).not.toThrow();
      expect(yield* f.sql`SELECT task_id FROM project_team_dispatch`).toEqual([]);
      const attemptsBefore = before.attempts;
      const ownerAttempts = before.attempts.filter((a) => a.taskId === questionTask);
      expect(ownerAttempts).toHaveLength(1);
      expect(ownerAttempts[0]?.attemptId).toBe(questionBinding.attemptId);
      expect(
        before.foundationRecords?.find((r) => r.recordId === questionBinding.recordId),
      ).toEqual(questionBinding);
      expect(questionBinding.status).toBe("running");
      expect(deriveProjectWorkClaimPrerequisites(before, questionTask)).toEqual({
        claimable: false,
        reason: "task-not-ready",
      });

      const question = before.foundationRecords?.find((r) => r.recordId === "wake-question");
      if (question?.kind !== "question") return yield* Effect.die("Pending question absent");
      const answer = {
        type: "project-team.question.answer" as const,
        commandId: CommandId.make("answer-on-second-device"),
        projectId,
        taskId: questionTask,
        expectedRevision: before.revision,
        expectedTaskRevision: before.tasks.find((t) => t.taskId === questionTask)!.revision,
        specRevision: task.specRevision,
        planRevision: questionBinding.planRevision,
        questionId: question.recordId,
        expectedQuestionRevision: question.revision,
        expectedGateRevision: gate.revision,
        answer: "Keep",
      };
      const receipt = yield* gateway.write(
        answer,
        { kind: "human", id: "maintainer" },
        { kind: "mobile", id: "second-device" },
      );
      // Await the automatic wake first; drain itself requests a sweep and cannot prove a wake.
      const awakened = yield* Queue.take(sweeps);
      const cursor = yield* f.sql<{
        cursor: number;
      }>`SELECT MAX(sequence) AS cursor FROM project_work_events WHERE command_id=${answer.commandId}`;
      yield* reactor.observed(cursor[0]!.cursor);
      yield* reactor.drain(cursor[0]!.cursor);
      expect(awakened.committed).toHaveLength(1);
      expect(awakened.blocked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: "cancel-task", phase: "eligibility" }),
          expect.objectContaining({ taskId: "stale-task", phase: "eligibility" }),
          expect.objectContaining({
            taskId: "gated-task",
            phase: "eligibility",
            reason: "explicit-authorization-required",
          }),
        ]),
      );
      expect(awakened.blocked.map((b) => b.taskId)).toContain(ProjectWorkTaskId.make("pause-task"));
      const answered = yield* readCurrentState(f.sql, projectId);
      expect(answered.attempts.filter((a) => a.taskId === questionTask)).toEqual(ownerAttempts);
      expect(
        answered.foundationRecords?.find((r) => r.recordId === questionBinding.recordId),
      ).toEqual(questionBinding);
      expect(deriveProjectWorkClaimPrerequisites(answered, questionTask)).toEqual({
        claimable: false,
        reason: "task-not-ready",
      });
      expect(answered.tasks.filter((t) => t.taskId !== taskId)).toEqual(
        before.tasks.filter((t) => t.taskId !== taskId),
      );
      expect(answered.attempts).toHaveLength(attemptsBefore.length + 1);
      expect(answered.attempts.filter((a) => a.taskId !== taskId)).toEqual(attemptsBefore);
      expect(
        answered.foundationRecords?.filter((r) =>
          ["pause-task", "cancel-task", "gated-task", "stale-task"].includes(
            "taskId" in r ? (r.taskId ?? "") : "",
          ),
        ),
      ).toEqual(
        before.foundationRecords?.filter((r) =>
          ["pause-task", "cancel-task", "gated-task", "stale-task"].includes(
            "taskId" in r ? (r.taskId ?? "") : "",
          ),
        ),
      );
      const eligibleGrant =
        f.request.claim.transition?.kind === "claim"
          ? f.request.claim.transition.authorizationGateId
          : undefined;
      expect(
        answered.foundationRecords?.filter(
          (r) => r.kind === "gate" && r.recordId !== eligibleGrant,
        ),
      ).toEqual(
        before.foundationRecords?.filter((r) => r.kind === "gate" && r.recordId !== eligibleGrant),
      );
      expect(gate.status).toBe("pending");
      expect(answered.foundationRecords?.find((r) => r.recordId === gate.recordId)).toEqual(gate);
      expect(
        answered.foundationRecords?.find((r) => r.recordId === question.recordId),
      ).toMatchObject({
        status: "answered",
        answer: "Keep",
        answeredBy: {
          actor: { kind: "human", id: "maintainer" },
          source: { kind: "mobile", id: "second-device" },
          recordedAt: "2026-01-01T00:00:00.001Z",
        },
      });
      expect(yield* f.sql`SELECT task_id FROM project_team_dispatch`).toEqual([
        { task_id: taskId },
      ]);
      const attributionRows =
        yield* f.sql`SELECT command_id, actor_kind, actor_id, source_kind, source_id
        FROM project_work_command_receipts
        WHERE project_id=${projectId} AND command_id IN ('request-on-first-device', ${answer.commandId})
        ORDER BY command_id`;
      expect(attributionRows).toEqual([
        {
          command_id: answer.commandId,
          actor_kind: "human",
          actor_id: "maintainer",
          source_kind: "mobile",
          source_id: "second-device",
        },
        {
          command_id: "request-on-first-device",
          actor_kind: "agent",
          actor_id: principal.actor.id,
          source_kind: "mcp",
          source_id: "first-device",
        },
      ]);
      expect(
        yield* f.sql`SELECT
        json_extract(payload_json, '$.record.answer') AS answer,
        json_extract(payload_json, '$.record.answeredBy.actor.id') AS actor,
        json_extract(payload_json, '$.record.answeredBy.source.kind') AS source,
        json_extract(payload_json, '$.record.answeredBy.source.id') AS client
        FROM project_work_events WHERE command_id=${answer.commandId}`,
      ).toEqual([
        { answer: "Keep", actor: "maintainer", source: "mobile", client: "second-device" },
      ]);
      const answerEvents =
        yield* f.sql`SELECT command_id, payload_json FROM project_work_events WHERE command_id=${answer.commandId}`;
      expect(answerEvents).toHaveLength(1);
      const projection = yield* ProjectWorkProjection;
      yield* reactor.stop;
      yield* projection.rebuild(projectId);
      const restartedJournal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 2,
      });
      const restartedScheduler = yield* makeScheduler(restartedJournal);
      const restarted = yield* makeProjectTeamExecutionReactor({
        start: Effect.succeed({
          ready: Effect.void,
          sweep: restartedScheduler.sweep().pipe(Effect.asVoid),
          stop: Effect.void,
        }),
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
      );
      yield* restarted.ready;
      expect(
        yield* gateway.write(
          answer,
          { kind: "human", id: "maintainer" },
          { kind: "mobile", id: "second-device" },
        ),
      ).toEqual(receipt);
      yield* restarted.drain();
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(answered);
      expect(
        yield* f.sql`SELECT command_id, payload_json FROM project_work_events WHERE command_id=${answer.commandId}`,
      ).toEqual(answerEvents);
      expect(yield* f.sql`SELECT task_id FROM project_team_dispatch`).toEqual([
        { task_id: taskId },
      ]);
      expect(
        yield* f.sql`SELECT command_id, actor_kind, actor_id, source_kind, source_id
        FROM project_work_command_receipts
        WHERE project_id=${projectId} AND command_id IN ('request-on-first-device', ${answer.commandId})
        ORDER BY command_id`,
      ).toEqual(attributionRows);
      expect(yield* restartedJournal.readRecoveryPage({ limit: 32 })).toHaveLength(1);
    }).pipe(
      Effect.provide(
        ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime)).pipe(
          Layer.provideMerge(ProjectWorkEventBusLive),
        ),
      ),
    ),
);
