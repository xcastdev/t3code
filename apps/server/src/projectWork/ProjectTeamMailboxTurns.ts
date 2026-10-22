import {
  canonicalProjectWorkPayload,
  type ProjectTeamRecord,
  type ProjectTeamWriteIntent,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

type Message = Extract<ProjectTeamRecord, { kind: "message" }>;
type Question = Extract<ProjectTeamRecord, { kind: "question" }>;
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Communication = Extract<
  ProjectTeamWriteIntent,
  {
    type:
      | "project-team.message.send"
      | "project-team.question.request"
      | "project-team.question.answer";
  }
>;
const reject = (message: string): never => {
  throw new ProjectWorkPolicyError("invalid-state", message);
};
const records = (state: ProjectWorkReducerState) => state.foundationRecords ?? [];

/** Called inside the Work authorization transaction after transport identity is established. */
export const compileProjectTeamCommunication = (
  state: ProjectWorkReducerState,
  input: Communication,
  attribution: ProjectWorkAttribution,
): Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> => {
  const task = state.tasks.find((t) => t.taskId === input.taskId);
  if (
    state.revision !== input.expectedRevision ||
    task?.revision !== input.expectedTaskRevision ||
    task.specRevision !== input.specRevision
  )
    return reject("Communication source revision changed");
  const all = records(state);
  const sender = all.find(
    (r) =>
      r.kind === "member" &&
      (attribution.actor.kind === "human"
        ? r.coordinator && r.status === "active"
        : r.recordId === attribution.actor.id),
  );
  const worker = all.find(
    (r) =>
      r.kind === "run-binding" &&
      r.taskId === input.taskId &&
      r.status === "running" &&
      r.memberId === attribution.actor.id,
  );
  if (
    attribution.actor.kind !== "human" &&
    (sender?.kind !== "member" ||
      sender.status !== "active" ||
      worker?.kind !== "run-binding" ||
      worker.specRevision !== input.specRevision ||
      worker.planRevision !== input.planRevision)
  )
    return reject("Communication requires current member authority");
  const at = attribution.recordedAt;
  const fields = { projectId: input.projectId, revision: 0, generation: 0, updatedAt: at };
  let record: ProjectTeamRecord;
  if (input.type === "project-team.message.send") {
    // Human communication uses the project coordinator; command attribution retains the human identity.
    if (sender?.kind !== "member" || sender.status !== "active")
      return reject("Message sender is unavailable");
    const recipient = all.find((r) => r.kind === "member" && r.recordId === input.recipientId);
    const membership = all.find(
      (r) => r.kind === "task-membership" && r.taskId === input.recipientTaskId,
    );
    if (
      recipient?.kind !== "member" ||
      recipient.status !== "active" ||
      membership?.kind !== "task-membership" ||
      membership.status !== "active" ||
      membership.revision !== input.expectedRecipientMembershipRevision ||
      (membership.controlState !== undefined && membership.controlState !== "active")
    )
      return reject("Message recipient changed");
    if (all.some((r) => r.recordId === input.messageId))
      return reject("Message identity already exists");
    if (
      input.replyTo !== undefined &&
      !all.some(
        (r) =>
          r.kind === "message" &&
          r.recordId === input.replyTo &&
          r.taskId === input.recipientTaskId &&
          (r.senderId === input.recipientId || r.recipientId === input.recipientId),
      )
    )
      return reject("Reply is outside recipient scope");
    record = {
      ...fields,
      kind: "message",
      recordId: input.messageId,
      status: "queued",
      commandId: input.commandId,
      senderId: sender.recordId,
      recipientId: input.recipientId,
      taskId: input.recipientTaskId,
      body: input.body,
      evidenceIds: input.evidenceIds,
      deliveryGeneration: 0,
      deliveryCursor: 0,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    };
  } else {
    const existingQuestion = all.find(
      (r): r is Question => r.kind === "question" && r.recordId === input.questionId,
    );
    const gateId =
      input.type === "project-team.question.request"
        ? input.targetGateId
        : existingQuestion?.targetGateId;
    const gate = all.find((r) => r.kind === "gate" && r.recordId === gateId);
    if (
      gate?.kind !== "gate" ||
      gate.taskId !== input.taskId ||
      gate.revision !== input.expectedGateRevision ||
      gate.specRevision !== input.specRevision ||
      gate.planRevision !== input.planRevision ||
      !["pending", "proposed"].includes(gate.status)
    )
      return reject("Question target changed");
    if (input.type === "project-team.question.request") {
      if (
        sender?.kind !== "member" ||
        sender.status !== "active" ||
        all.some((r) => r.recordId === input.questionId)
      )
        return reject("Question source is unavailable");
      record = {
        ...fields,
        kind: "question",
        recordId: input.questionId,
        status: "pending",
        taskId: input.taskId,
        senderId: sender.recordId,
        targetGateId: gate.recordId,
        targetRevision: gate.revision,
        body: input.body,
        choices: input.choices,
      };
    } else {
      const question = all.find(
        (r): r is Question => r.kind === "question" && r.recordId === input.questionId,
      );
      if (
        attribution.actor.kind !== "human" ||
        question === undefined ||
        question.taskId !== input.taskId ||
        question.status !== "pending" ||
        question.revision !== input.expectedQuestionRevision ||
        question.targetRevision !== gate.revision ||
        (question.choices.length > 0 && !question.choices.includes(input.answer))
      )
        return reject("Question answer is stale or unauthorized");
      record = {
        ...question,
        revision: question.revision + 1,
        updatedAt: at,
        status: "answered",
        answer: input.answer,
        answeredBy: attribution,
      };
    }
  }
  return {
    type: "project-work.foundation.commit",
    projectId: input.projectId,
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    attribution,
    committedAt: at,
    records: [record],
  };
};

export const assertProjectTeamQuestionUpdate = (old: Question, next: Question) => {
  const source = ({
    status: _status,
    revision: _revision,
    updatedAt: _at,
    seenAt: _seen,
    answer: _answer,
    answeredBy: _by,
    ...rest
  }: Question) => rest;
  if (
    canonicalProjectWorkPayload(source(old)) !== canonicalProjectWorkPayload(source(next)) ||
    old.status !== "pending" ||
    (next.status === "pending" && (next.answer !== undefined || next.answeredBy !== undefined))
  )
    reject("Question source and completed answer are immutable");
};

export interface ProjectTeamMailboxFence {
  readonly bindingId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly at: string;
}
const currentBinding = (
  state: ProjectWorkReducerState,
  input: ProjectTeamMailboxFence,
): Binding => {
  const binding = records(state).find(
    (r): r is Binding => r.kind === "run-binding" && r.recordId === input.bindingId,
  );
  const membership = records(state).find(
    (r) => r.kind === "task-membership" && r.taskId === binding?.taskId,
  );
  const task = state.tasks.find((t) => t.taskId === binding?.taskId);
  if (
    binding === undefined ||
    binding.generation !== input.generation ||
    binding.status !== "running" ||
    binding.runId === undefined ||
    task?.specRevision !== binding.specRevision ||
    membership?.kind !== "task-membership" ||
    membership.status !== "active" ||
    membership.generation !== binding.leaseGeneration ||
    (membership.controlState !== undefined && membership.controlState !== "active")
  )
    return reject("Mailbox binding generation is no longer current");
  return binding;
};

/** Persist these records before V2 receives the operation. An uncertain claim is never retried as a new operation. */
export const planMailboxClaim = (
  state: ProjectWorkReducerState,
  input: ProjectTeamMailboxFence,
): ReadonlyArray<ProjectTeamRecord> => {
  const binding = currentBinding(state, input);
  const all = records(state);
  const prior = all.find((r) => r.kind === "effect" && r.effectId === input.operationId);
  if (prior !== undefined) {
    if (
      prior.kind !== "effect" ||
      prior.effectKind !== "mailbox-wake" ||
      prior.sourceId !== binding.recordId ||
      prior.sourceGeneration !== binding.generation
    )
      return reject("Mailbox operation identity changed");
    return [];
  }
  const messages = all.filter(
    (r): r is Message =>
      r.kind === "message" && r.recipientId === binding.memberId && r.taskId === binding.taskId,
  );
  if (messages.some((m) => m.status === "uncertain")) return [];
  // Queued records are appended in commit order and never updated before their first claim.
  // Work checkpoints preserve that array order; timestamps and caller IDs cannot order commits.
  const message = messages.find((m) => m.status === "queued");
  if (message === undefined) return [];
  const cursor = Math.max(0, ...messages.map((m) => m.deliveryCursor)) + 1;
  return [
    {
      ...message,
      revision: message.revision + 1,
      updatedAt: input.at,
      status: "uncertain",
      deliveryGeneration: binding.generation,
      deliveryCursor: cursor,
    },
    {
      kind: "effect",
      recordId: input.operationId,
      projectId: binding.projectId,
      revision: 0,
      generation: binding.generation,
      updatedAt: input.at,
      status: "claimed",
      effectId: input.operationId,
      effectKind: "mailbox-wake",
      taskId: binding.taskId,
      ...(binding.runId === undefined ? {} : { runId: binding.runId }),
      sourceId: binding.recordId,
      sourceGeneration: binding.generation,
      targetId: message.recordId,
      payload: { recordIds: [message.recordId], expectedRevision: message.revision + 1 },
      claimGeneration: 1,
      availableAt: input.at,
    },
  ];
};

/** The caller supplies only an exact V2 receipt, never provider-authored prose. */
export const planMailboxReflection = (
  state: ProjectWorkReducerState,
  input: ProjectTeamMailboxFence & {
    readonly runId: string;
    readonly commandId: string;
    readonly threadId: string;
    readonly outcome: "delivered" | "uncertain";
  },
): ReadonlyArray<ProjectTeamRecord> => {
  const binding = currentBinding(state, input);
  const effect = records(state).find(
    (r) => r.kind === "effect" && r.effectId === input.operationId,
  );
  if (
    effect?.kind !== "effect" ||
    effect.effectKind !== "mailbox-wake" ||
    effect.sourceId !== binding.recordId ||
    effect.sourceGeneration !== binding.generation ||
    input.commandId !== input.operationId ||
    input.threadId !== binding.threadId ||
    input.runId.length === 0
  )
    return reject("Mailbox receipt does not match its retained operation");
  if (effect.status === "succeeded") return [];
  const message = records(state).find(
    (r) => r.kind === "message" && r.recordId === effect.targetId,
  );
  if (
    message?.kind !== "message" ||
    message.status !== "uncertain" ||
    message.deliveryGeneration !== binding.generation ||
    message.revision !== effect.payload.expectedRevision
  )
    return reject("Mailbox claim has changed");
  if (input.outcome === "uncertain") return [];
  return [
    { ...message, status: "delivered", revision: message.revision + 1, updatedAt: input.at },
    { ...effect, status: "succeeded", revision: effect.revision + 1, updatedAt: input.at },
  ];
};

/** Receipt acknowledgement and issue resolution are separate explicit transitions. */
export const planMailboxAttention = (
  state: ProjectWorkReducerState,
  input: {
    readonly messageId: string;
    readonly expectedRevision: number;
    readonly action: "acknowledge" | "resolve";
    readonly at: string;
  },
): Message => {
  const message = records(state).find(
    (r): r is Message => r.kind === "message" && r.recordId === input.messageId,
  );
  if (
    message === undefined ||
    message.revision !== input.expectedRevision ||
    !(input.action === "acknowledge"
      ? message.status === "delivered"
      : ["delivered", "acknowledged"].includes(message.status))
  )
    return reject("Message attention state changed");
  return {
    ...message,
    revision: message.revision + 1,
    updatedAt: input.at,
    ...(input.action === "acknowledge"
      ? { status: "acknowledged", acknowledgedAt: input.at }
      : { status: "resolved", resolvedAt: input.at }),
  };
};

/** A command replay returns its original receipt while current records may have advanced delivery state. */
export const assertProjectTeamCommunicationReplay = (
  state: ProjectWorkReducerState,
  events: ReadonlyArray<import("./ProjectWorkDecider.ts").ProjectWorkEvent>,
) => {
  const source = (record: ProjectTeamRecord) => {
    const mutable = new Set([
      "status",
      "revision",
      "updatedAt",
      "deliveryGeneration",
      "deliveryCursor",
      "acknowledgedAt",
      "resolvedAt",
      "seenAt",
      "answer",
      "answeredBy",
    ]);
    return canonicalProjectWorkPayload(
      Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key))),
    );
  };
  const original = events.flatMap((event) =>
    event.type === "project-work.foundation.recorded" &&
    (event.record.kind === "message" || event.record.kind === "question")
      ? [event.record]
      : [],
  );
  if (original.length !== 1) return reject("Communication receipt source is unavailable");
  const prior = original[0]!;
  const current = records(state).find((r) => r.recordId === prior.recordId);
  if (
    current === undefined ||
    current.kind !== prior.kind ||
    source(current) !== source(prior) ||
    current.status === "canceled"
  )
    return reject("Communication receipt source changed");
  if (current.kind === "question") {
    const gate = records(state).find(
      (r) => r.kind === "gate" && r.recordId === current.targetGateId,
    );
    if (
      gate?.kind !== "gate" ||
      gate.revision !== current.targetRevision ||
      !["pending", "proposed"].includes(gate.status)
    )
      return reject("Question receipt target changed");
    if (
      prior.kind === "question" &&
      prior.status === "answered" &&
      (current.answer !== prior.answer ||
        canonicalProjectWorkPayload(current.answeredBy) !==
          canonicalProjectWorkPayload(prior.answeredBy))
    )
      return reject("Question receipt answer changed");
  }
};
