import {
  ProjectId,
  ProjectTeamMember,
  ProjectTeamMessage,
  ProjectTeamRunBinding,
  ProjectTeamTaskMembership,
  ProjectWorkTask,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const CurrentRecipient = Schema.Struct({
  member: ProjectTeamMember,
  runBinding: ProjectTeamRunBinding,
  taskMembership: ProjectTeamTaskMembership,
  task: ProjectWorkTask,
});
const Candidate = Schema.Struct({ ...CurrentRecipient.fields, safeTurnBoundary: Schema.Boolean });
const DeliveryTarget = Schema.Struct({
  projectId: ProjectId,
  messageId: ProjectTeamMessage.fields.recordId,
  messageRevision: ProjectTeamMessage.fields.revision,
  runBindingRecordId: ProjectTeamRunBinding.fields.recordId,
  attemptId: ProjectTeamRunBinding.fields.attemptId,
  bindingGeneration: ProjectTeamRunBinding.fields.generation,
  leaseGeneration: ProjectTeamRunBinding.fields.leaseGeneration,
  deliveryGeneration: ProjectTeamMessage.fields.deliveryGeneration,
  deliveryCursor: ProjectTeamMessage.fields.deliveryCursor,
});
const PlanInput = Schema.Struct({
  projectId: ProjectId,
  messages: Schema.Array(ProjectTeamMessage).check(Schema.isMaxLength(128)),
  candidates: Schema.Array(Candidate).check(Schema.isMaxLength(128)),
});
const Receipt = Schema.Struct({
  ...DeliveryTarget.fields,
  expectedMessageRevision: ProjectTeamMessage.fields.revision,
  status: Schema.Literals(["delivered", "acknowledged", "resolved", "uncertain"]),
  at: ProjectTeamMessage.fields.updatedAt,
});
const ReceiptInput = Schema.Struct({
  message: ProjectTeamMessage,
  current: CurrentRecipient,
  recordedTarget: Schema.Union([DeliveryTarget, Schema.Undefined]),
  receipt: Receipt,
});
const isPlanInput = Schema.is(PlanInput);
const isReceiptInput = Schema.is(ReceiptInput);
type Message = typeof ProjectTeamMessage.Type;
type Target = typeof DeliveryTarget.Type;
const rejected = (reason: string) => ({ accepted: false as const, reason });

const hasScope = (message: Message) =>
  message.taskId !== undefined || message.missionId !== undefined;
const matchesScope = (message: Message, current: typeof CurrentRecipient.Type) =>
  current.member.recordId === message.recipientId &&
  (message.taskId === undefined || message.taskId === current.runBinding.taskId) &&
  (message.missionId === undefined || message.missionId === current.taskMembership.missionId);

const recipientUnavailable = (
  projectId: Message["projectId"],
  message: Message,
  current: typeof CurrentRecipient.Type,
) => {
  const { member, runBinding, taskMembership, task } = current;
  if (
    message.projectId !== projectId ||
    member.projectId !== projectId ||
    runBinding.projectId !== projectId ||
    taskMembership.projectId !== projectId ||
    task.projectId !== projectId
  )
    return "project-mismatch";
  if (
    !hasScope(message) ||
    !matchesScope(message, current) ||
    runBinding.memberId !== member.recordId ||
    runBinding.taskId !== taskMembership.taskId ||
    runBinding.taskId !== task.taskId ||
    runBinding.attemptId !== task.activeAttemptId
  )
    return "recipient-scope-mismatch";
  if (
    member.status !== "active" ||
    runBinding.status !== "running" ||
    taskMembership.status !== "active" ||
    taskMembership.executionKind !== "managed" ||
    (taskMembership.controlState !== undefined && taskMembership.controlState !== "active") ||
    task.state !== "in-progress"
  )
    return "recipient-inactive";
  if (
    !Number.isSafeInteger(runBinding.generation) ||
    !Number.isSafeInteger(runBinding.leaseGeneration)
  )
    return "counter-exhausted";
  return undefined;
};

/** Root supplies verified current records and persists each target with its effect atomically. */
export const planMessageDelivery = (input: typeof PlanInput.Type) => {
  if (
    !Array.isArray(input?.messages) ||
    !Array.isArray(input?.candidates) ||
    input.messages.length > 128 ||
    input.candidates.length > 128 ||
    !isPlanInput(input)
  )
    return rejected("invalid-input");
  if (new Set(input.messages.map((message) => message.recordId)).size !== input.messages.length)
    return rejected("ambiguous-message");
  const deliveries: { message: Message; target: Target }[] = [];
  const deferred: { messageId: string; reason: string }[] = [];
  const ordered = [...input.messages].sort((a, b) =>
    a.recordId < b.recordId
      ? -1
      : a.recordId > b.recordId
        ? 1
        : a.deliveryCursor - b.deliveryCursor,
  );
  for (const message of ordered) {
    const candidates = input.candidates.filter((current) => matchesScope(message, current));
    const current = candidates[0];
    const reason =
      message.status !== "queued"
        ? "message-not-queued"
        : !hasScope(message)
          ? "scope-required"
          : candidates.length > 1
            ? "ambiguous-target"
            : current === undefined
              ? "recipient-unavailable"
              : (recipientUnavailable(input.projectId, message, current) ??
                (!current.safeTurnBoundary ? "safe-boundary-required" : undefined) ??
                (!Number.isSafeInteger(message.deliveryCursor) ||
                message.deliveryCursor >= Number.MAX_SAFE_INTEGER ||
                !Number.isSafeInteger(message.revision) ||
                message.revision >= Number.MAX_SAFE_INTEGER
                  ? "counter-exhausted"
                  : undefined));
    if (reason !== undefined || current === undefined) {
      deferred.push({ messageId: message.recordId, reason: reason ?? "recipient-unavailable" });
      continue;
    }
    deliveries.push({
      message,
      target: {
        projectId: message.projectId,
        messageId: message.recordId,
        messageRevision: message.revision,
        runBindingRecordId: current.runBinding.recordId,
        attemptId: current.runBinding.attemptId,
        bindingGeneration: current.runBinding.generation,
        leaseGeneration: current.runBinding.leaseGeneration,
        deliveryGeneration: current.runBinding.leaseGeneration,
        deliveryCursor: message.deliveryCursor + 1,
      },
    });
  }
  return { accepted: true as const, deliveries, deferred };
};

const sameTarget = (a: Target, b: Target) =>
  a.projectId === b.projectId &&
  a.messageId === b.messageId &&
  a.messageRevision === b.messageRevision &&
  a.runBindingRecordId === b.runBindingRecordId &&
  a.attemptId === b.attemptId &&
  a.bindingGeneration === b.bindingGeneration &&
  a.leaseGeneration === b.leaseGeneration &&
  a.deliveryGeneration === b.deliveryGeneration &&
  a.deliveryCursor === b.deliveryCursor;

/** Returns a proposed transition, never durable consumption or permission to awaken a worker. */
export const applyMessageReceipt = (input: typeof ReceiptInput.Type) => {
  if (!isReceiptInput(input)) return rejected("invalid-input");
  const { message, current, recordedTarget, receipt } = input;
  if (recordedTarget === undefined) return rejected("delivery-target-required");
  if (!sameTarget(recordedTarget, receipt)) return rejected("stale-delivery-target");
  const unavailable = recipientUnavailable(recordedTarget.projectId, message, current);
  if (unavailable !== undefined) return rejected(unavailable);
  const run = current.runBinding;
  if (
    recordedTarget.messageId !== message.recordId ||
    recordedTarget.runBindingRecordId !== run.recordId ||
    recordedTarget.attemptId !== run.attemptId ||
    recordedTarget.bindingGeneration !== run.generation ||
    recordedTarget.leaseGeneration !== run.leaseGeneration ||
    recordedTarget.deliveryGeneration !== run.leaseGeneration ||
    !Number.isSafeInteger(recordedTarget.messageRevision) ||
    !Number.isSafeInteger(recordedTarget.deliveryCursor) ||
    recordedTarget.deliveryCursor < 1 ||
    !Number.isSafeInteger(message.revision) ||
    !Number.isSafeInteger(receipt.expectedMessageRevision)
  )
    return rejected("stale-delivery-target");
  const initial = message.status === "queued";
  if (
    initial
      ? recordedTarget.messageRevision !== message.revision ||
        recordedTarget.deliveryCursor !== message.deliveryCursor + 1
      : recordedTarget.messageRevision >= message.revision ||
        recordedTarget.deliveryCursor !== message.deliveryCursor ||
        recordedTarget.deliveryGeneration !== message.deliveryGeneration
  )
    return rejected("stale-message-delivery");
  if (
    receipt.status === message.status &&
    receipt.at === message.updatedAt &&
    receipt.expectedMessageRevision === message.revision - 1 &&
    (receipt.status !== "acknowledged" || receipt.at === message.acknowledgedAt) &&
    (receipt.status !== "resolved" || receipt.at === message.resolvedAt)
  )
    return { accepted: true as const, changed: false, message };
  if (receipt.expectedMessageRevision !== message.revision)
    return rejected("stale-message-revision");
  if (message.revision >= Number.MAX_SAFE_INTEGER) return rejected("counter-exhausted");
  const validTransition =
    (message.status === "queued" &&
      (receipt.status === "delivered" || receipt.status === "uncertain")) ||
    (message.status === "delivered" &&
      (receipt.status === "acknowledged" || receipt.status === "uncertain")) ||
    (message.status === "acknowledged" && receipt.status === "resolved");
  if (!validTransition) return rejected("invalid-receipt-transition");
  const next: Message = {
    ...message,
    revision: message.revision + 1,
    updatedAt: receipt.at,
    status: receipt.status,
    deliveryGeneration: recordedTarget.deliveryGeneration,
    deliveryCursor: recordedTarget.deliveryCursor,
    ...(receipt.status === "acknowledged" ? { acknowledgedAt: receipt.at } : {}),
    ...(receipt.status === "resolved" ? { resolvedAt: receipt.at } : {}),
  };
  return { accepted: true as const, changed: true, message: next };
};
