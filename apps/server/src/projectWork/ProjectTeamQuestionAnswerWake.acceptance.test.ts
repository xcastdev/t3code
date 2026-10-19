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
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
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
  "a second device answer wakes execution and sweeps current eligibility without approving or resuming work",
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
      for (const action of ["pause", "cancel"] as const) {
        const siblingTask = ProjectWorkTaskId.make(`${action}-task`);
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
            execute: (command) =>
              command.type === "project-work.foundation.commit" &&
              command.transition?.kind === "claim"
                ? Effect.fail(
                    new ProjectWorkPolicyError("invalid-state", "Retain unclaimed sibling"),
                  )
                : f.repository.execute(command),
          }),
          Effect.result,
        );
        const current = yield* readCurrentState(f.sql, projectId);
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
      const scheduler = yield* makeProjectTeamScheduler({
        environmentId: "environment",
        ports: {
          ...view,
          reserve: f.journal.reserve,
          prepareRequest: ({ state, taskId: selected }) =>
            selected === taskId
              ? Effect.succeed({
                  _tag: "Prepared" as const,
                  request: {
                    ...f.request,
                    claim: { ...f.request.claim, expectedRevision: state.revision },
                  },
                })
              : Effect.succeed({
                  _tag: "Blocked" as const,
                  reason: "No new request for active or controlled task",
                }),
        },
      });
      const sweeps = yield* Queue.unbounded<Effect.Success<ReturnType<typeof scheduler.sweep>>>();
      // Establish the eligible dispatch before subscribing, so startup has no writes or queued event wakes.
      expect((yield* scheduler.sweep()).committed).toHaveLength(1);
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
      expect(awakened.committed).toEqual([]);
      expect(awakened.blocked.map((b) => b.taskId)).toContain(ProjectWorkTaskId.make("pause-task"));
      const answered = yield* readCurrentState(f.sql, projectId);
      expect(answered.tasks).toEqual(before.tasks);
      expect(gate.status).toBe("pending");
      expect(answered.foundationRecords?.find((r) => r.recordId === gate.recordId)).toEqual(gate);
      expect(
        answered.foundationRecords?.find((r) => r.recordId === question.recordId),
      ).toMatchObject({
        status: "answered",
        answer: "Keep",
        answeredBy: { source: { kind: "mobile", id: "second-device" } },
      });
      expect(yield* f.sql`SELECT task_id FROM project_team_dispatch`).toEqual([
        { task_id: taskId },
      ]);
      expect(
        answered.foundationRecords?.filter(
          (r) => r.kind === "task-membership" && ["pause-task", "cancel-task"].includes(r.taskId),
        ),
      ).toEqual(
        before.foundationRecords?.filter(
          (r) => r.kind === "task-membership" && ["pause-task", "cancel-task"].includes(r.taskId),
        ),
      );
      expect(
        yield* gateway.write(
          answer,
          { kind: "human", id: "maintainer" },
          { kind: "mobile", id: "second-device" },
        ),
      ).toEqual(receipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(answered);
    }).pipe(
      Effect.provide(
        ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime)).pipe(
          Layer.provideMerge(ProjectWorkEventBusLive),
        ),
      ),
    ),
);
