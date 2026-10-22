import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import {
  CommandId,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
  type ProjectWorkReducerState,
  type ProjectWorkEvent,
} from "./ProjectWorkDecider.ts";
import {
  compileProjectTeamCommunication,
  assertProjectTeamQuestionUpdate,
  planMailboxClaim,
  planMailboxReflection,
  planMailboxAttention,
  assertProjectTeamCommunicationReplay,
} from "./ProjectTeamMailboxTurns.ts";
const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("mailbox-project");
const taskId = ProjectWorkTaskId.make("task");
const record = Schema.decodeUnknownSync(ProjectTeamRecord);
const setup = () => {
  const empty = emptyProjectWorkReducerState(projectId);
  const state = applyProjectWorkEvents(
    empty,
    decideProjectWorkCommand(empty, {
      type: "project-work.task.create",
      projectId,
      taskId,
      title: "Mailbox",
      commandId: CommandId.make("create"),
      createdAt: at,
    }),
  );
  const fields = { projectId, revision: 0, generation: 0, updatedAt: at };
  state.foundationRecords = [
    record({
      ...fields,
      kind: "task-membership",
      recordId: "membership",
      taskId,
      status: "active",
      executionKind: "managed",
      deliverableKind: "code",
      controlState: "active",
    }),
    record({
      ...fields,
      kind: "member",
      recordId: "worker",
      status: "active",
      name: "Worker",
      coordinator: true,
      roleRevisionId: "role",
    }),
    record({
      ...fields,
      kind: "run-binding",
      recordId: "binding",
      taskId,
      status: "running",
      attemptId: "attempt",
      memberId: "worker",
      roleRevisionId: "role",
      providerInstanceId: "codex",
      threadId: "thread",
      runId: "run",
      environmentId: "env",
      model: "model",
      configuration: {
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "v2",
        maxTokens: 1000,
        maxDurationMs: 1000,
        paidFallback: false,
      },
      worktree: "/tmp/worktree",
      branch: "work",
      leaseGeneration: 0,
      specRevision: 0,
      planRevision: 0,
    }),
    ...["b", "a"].map((id) =>
      record({
        ...fields,
        kind: "message",
        recordId: id,
        status: "queued",
        commandId: id,
        senderId: "sender",
        recipientId: "worker",
        taskId,
        body: id,
        evidenceIds: [],
        deliveryGeneration: 0,
        deliveryCursor: 0,
      }),
    ),
  ];
  return state;
};
const merge = (state: ProjectWorkReducerState, additions: ReadonlyArray<ProjectTeamRecord>) => ({
  ...state,
  foundationRecords: [
    ...state.foundationRecords!.filter(
      (r) => !additions.some((next) => next.recordId === r.recordId),
    ),
    ...additions,
  ],
});
const fence = { bindingId: "binding", generation: 0, operationId: "operation", at };
it("retains the first ordered claim across restart and blocks later delivery until reflection", () => {
  let state = setup();
  const claimed = planMailboxClaim(state, fence);
  expect(claimed[0]).toMatchObject({ recordId: "b", status: "uncertain", deliveryCursor: 1 });
  state = merge(state, claimed);
  const restarted = structuredClone(state);
  expect(planMailboxClaim(restarted, fence)).toEqual([]);
  expect(planMailboxClaim(restarted, { ...fence, operationId: "next" })).toEqual([]);
  state = merge(
    state,
    planMailboxReflection(restarted, {
      ...fence,
      runId: "mailbox-run",
      commandId: "operation",
      threadId: "thread",
      outcome: "delivered",
    }),
  );
  expect(
    planMailboxReflection(state, {
      ...fence,
      runId: "mailbox-run",
      commandId: "operation",
      threadId: "thread",
      outcome: "delivered",
    }),
  ).toEqual([]);
  expect(planMailboxClaim(state, { ...fence, operationId: "next" })[0]).toMatchObject({
    recordId: "a",
    deliveryCursor: 2,
  });
});
it("keeps uncertain receipts and rejects a different run or replaced generation", () => {
  const state = merge(setup(), planMailboxClaim(setup(), fence));
  expect(
    planMailboxReflection(state, {
      ...fence,
      runId: "mailbox-run",
      commandId: "operation",
      threadId: "thread",
      outcome: "uncertain",
    }),
  ).toEqual([]);
  expect(() =>
    planMailboxReflection(state, {
      ...fence,
      runId: "mailbox-run",
      commandId: "other",
      threadId: "thread",
      outcome: "delivered",
    }),
  ).toThrow();
  const replaced = merge(
    state,
    state
      .foundationRecords!.filter((r) => r.kind === "run-binding")
      .map((r) => ({ ...r, generation: 1 })),
  );
  expect(() =>
    planMailboxReflection(replaced, {
      ...fence,
      runId: "mailbox-run",
      commandId: "operation",
      threadId: "thread",
      outcome: "delivered",
    }),
  ).toThrow();
});
it("rejects delivery after pause or lease replacement", () => {
  const state = merge(setup(), planMailboxClaim(setup(), fence));
  for (const update of [{ controlState: "paused" as const }, { generation: 1 }]) {
    const membership = state.foundationRecords!.find((r) => r.kind === "task-membership")!;
    expect(() =>
      planMailboxReflection(merge(state, [{ ...membership, ...update }]), {
        ...fence,
        runId: "mailbox-run",
        commandId: "operation",
        threadId: "thread",
        outcome: "delivered",
      }),
    ).toThrow();
  }
});
it("retains human answers on the exact source and rejects stale or repeated answers", () => {
  const state = setup();
  state.foundationRecords!.push(
    record({
      projectId,
      recordId: "gate",
      revision: 0,
      generation: 0,
      updatedAt: at,
      kind: "gate",
      status: "pending",
      taskId,
      gate: "specification",
      specRevision: 0,
      planRevision: 0,
      contentHash: "hash",
      evidenceIds: [],
      attribution: {
        actor: { kind: "human", id: "worker" },
        source: { kind: "web", id: "client" },
        recordedAt: at,
      },
    }),
  );
  const attribution = {
    actor: { kind: "human" as const, id: "worker" },
    source: { kind: "web" as const, id: "client" },
    recordedAt: at,
  };
  const common = {
    projectId,
    taskId,
    commandId: CommandId.make("question"),
    expectedRevision: state.revision,
    expectedTaskRevision: state.tasks[0]!.revision,
    specRevision: 0,
    planRevision: 0,
    expectedGateRevision: 0,
  };
  const requested = compileProjectTeamCommunication(
    state,
    {
      ...common,
      type: "project-team.question.request",
      questionId: "question",
      targetGateId: "gate",
      body: "Proceed?",
      choices: ["yes", "no"],
    },
    attribution,
  );
  if (requested.type !== "project-work.foundation.commit")
    throw new Error("Expected foundation command");
  const requestEvents = decideProjectWorkCommand(state, requested);
  const waiting = applyProjectWorkEvents(state, requestEvents);
  const answer = {
    ...common,
    commandId: CommandId.make("answer"),
    expectedRevision: waiting.revision,
    type: "project-team.question.answer" as const,
    questionId: "question",
    expectedQuestionRevision: 0,
    answer: "yes",
  };
  const answered = compileProjectTeamCommunication(waiting, answer, attribution);
  if (answered.type !== "project-work.foundation.commit")
    throw new Error("Expected answer command");
  const persisted = applyProjectWorkEvents(waiting, decideProjectWorkCommand(waiting, answered));
  expect(() => assertProjectTeamCommunicationReplay(persisted, requestEvents)).not.toThrow();
  const gate = persisted.foundationRecords!.find((r) => r.recordId === "gate")!;
  expect(() =>
    assertProjectTeamCommunicationReplay(
      merge(persisted, [{ ...gate, revision: gate.revision + 1 }]),
      requestEvents,
    ),
  ).toThrow();
  expect(persisted.foundationRecords!.find((r) => r.recordId === "question")).toMatchObject({
    status: "answered",
    answer: "yes",
  });
  expect(answered.records[0]).toMatchObject({
    status: "answered",
    body: "Proceed?",
    targetRevision: 0,
    answer: "yes",
    answeredBy: attribution,
  });
  const prior = requested.records[0];
  const next = answered.records[0];
  if (prior?.kind !== "question" || next?.kind !== "question")
    throw new Error("Expected questions");
  expect(() => assertProjectTeamQuestionUpdate(prior, next)).not.toThrow();
  expect(() => assertProjectTeamQuestionUpdate(prior, { ...next, body: "Changed" })).toThrow();
  expect(() =>
    compileProjectTeamCommunication(waiting, { ...answer, expectedGateRevision: 1 }, attribution),
  ).toThrow();
  expect(() =>
    compileProjectTeamCommunication(merge(waiting, answered.records), answer, attribution),
  ).toThrow();
});

it("acknowledges delivery without resolving the message", () => {
  const claimed = merge(setup(), planMailboxClaim(setup(), fence));
  const delivered = merge(
    claimed,
    planMailboxReflection(claimed, {
      ...fence,
      runId: "mailbox-run",
      commandId: "operation",
      threadId: "thread",
      outcome: "delivered",
    }),
  );
  const message = delivered.foundationRecords!.find((r) => r.recordId === "b")!;
  const acknowledged = planMailboxAttention(delivered, {
    messageId: "b",
    expectedRevision: message.revision,
    action: "acknowledge",
    at,
  });
  expect(acknowledged.status).toBe("acknowledged");
  expect(acknowledged.resolvedAt).toBeUndefined();
  const resolved = planMailboxAttention(merge(delivered, [acknowledged]), {
    messageId: "b",
    expectedRevision: acknowledged.revision,
    action: "resolve",
    at,
  });
  expect(resolved).toMatchObject({ status: "resolved", acknowledgedAt: at, resolvedAt: at });
});

it("persists pause and descendant stop intentions while native launch is uncertain", () => {
  let state = setup();
  const childTaskId = ProjectWorkTaskId.make("child");
  state = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.task.create",
      projectId,
      taskId: childTaskId,
      title: "Child",
      commandId: CommandId.make("child"),
      createdAt: at,
    }),
  );
  const binding = state.foundationRecords!.find((r) => r.kind === "run-binding")!;
  const membership = state.foundationRecords!.find((r) => r.kind === "task-membership")!;
  if (binding.kind !== "run-binding" || membership.kind !== "task-membership")
    throw new Error("Missing fixture");
  const { runId: _run, ...childBinding } = binding;
  state.foundationRecords!.push(
    { ...membership, recordId: "child-membership", taskId: childTaskId, parentTaskId: taskId },
    { ...childBinding, recordId: "child-binding", taskId: childTaskId, status: "reserved" },
  );
  const command = {
    type: "project-work.foundation.commit" as const,
    projectId,
    commandId: CommandId.make("pause"),
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "human" as const, id: "maintainer" },
      source: { kind: "web" as const, id: "client" },
      recordedAt: at,
    },
    committedAt: at,
    records: [],
    guided: {
      intent: {
        type: "project-team.task.control" as const,
        projectId,
        taskId,
        commandId: CommandId.make("pause"),
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        control: { action: "pause" as const, reason: "Pause subtree" },
      },
    },
  };
  const paused = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
  expect(
    paused.foundationRecords!.filter((r) => r.kind === "run-binding").map((r) => r.status),
  ).toEqual(["stopping", "quarantined"]);
  const stops = paused.foundationRecords!.filter(
    (r) => r.kind === "effect" && r.effectKind === "stop",
  );
  expect(stops).toHaveLength(2);
  expect(stops).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceId: "child-binding",
        sourceGeneration: 0,
        status: "pending",
      }),
    ]),
  );
  const resume = {
    ...command,
    commandId: CommandId.make("resume"),
    expectedRevision: paused.revision,
    guided: {
      intent: {
        ...command.guided.intent,
        commandId: CommandId.make("resume"),
        expectedRevision: paused.revision,
        expectedTaskRevision: paused.tasks[0]!.revision,
        control: { action: "resume" as const, reason: "Resume" },
      },
    },
  };
  expect(() => decideProjectWorkCommand(paused, resume)).toThrow("drained");
});

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
effectIt.effect(
  "keeps same-millisecond committed enqueue order across SQLite event-log restart",
  () =>
    Effect.gen(function* () {
      const empty = emptyProjectWorkReducerState(projectId);
      const events: Array<ProjectWorkEvent> = [
        ...decideProjectWorkCommand(empty, {
          type: "project-work.task.create",
          projectId,
          taskId,
          title: "Mailbox",
          commandId: CommandId.make("restart-create"),
          createdAt: at,
        }),
      ];
      let state = applyProjectWorkEvents(empty, events);
      for (const record of setup().foundationRecords!.filter((r) => r.kind !== "message")) {
        const event: ProjectWorkEvent = {
          type: "project-work.foundation.recorded",
          projectId,
          eventId: EventId.make(`seed:${record.recordId}`),
          revision: state.revision + 1,
          occurredAt: at,
          record,
        };
        events.push(event);
        state = applyProjectWorkEvents(state, [event]);
      }
      for (const messageId of ["z-first", "a-second"]) {
        const command = compileProjectTeamCommunication(
          state,
          {
            type: "project-team.message.send",
            projectId,
            taskId,
            commandId: CommandId.make(messageId),
            expectedRevision: state.revision,
            expectedTaskRevision: state.tasks[0]!.revision,
            specRevision: 0,
            planRevision: 0,
            messageId,
            recipientId: "worker",
            recipientTaskId: taskId,
            expectedRecipientMembershipRevision: 0,
            body: messageId,
            evidenceIds: [],
          },
          {
            actor: { kind: "human", id: "maintainer" },
            source: { kind: "web", id: "client" },
            recordedAt: at,
          },
        );
        const committed = decideProjectWorkCommand(state, command);
        events.push(...committed);
        state = applyProjectWorkEvents(state, committed);
      }
      const sql = yield* SqlClient.SqlClient;
      for (const event of events) {
        const payload = yield* encodeEvent(event);
        yield* sql`INSERT INTO t3_workflow_v2_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json) VALUES (${event.eventId},${projectId},${event.type},${at},${event.eventId},${payload})`;
      }
      const restarted = yield* readCurrentState(sql, projectId);
      expect(planMailboxClaim(restarted, fence)[0]).toMatchObject({ recordId: "z-first" });
      const first = merge(restarted, planMailboxClaim(restarted, fence));
      const reflected = merge(
        first,
        planMailboxReflection(first, {
          ...fence,
          runId: "delivery",
          commandId: fence.operationId,
          threadId: "thread",
          outcome: "delivered",
        }),
      );
      expect(
        planMailboxClaim(reflected, { ...fence, operationId: "next-operation" })[0],
      ).toMatchObject({ recordId: "a-second" });
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
