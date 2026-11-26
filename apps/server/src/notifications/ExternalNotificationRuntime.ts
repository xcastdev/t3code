import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Notification,
  ProjectWorkAttentionRead,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProjectWorkEvent } from "../projectWork/ProjectWorkDecider.ts";
import * as ProjectWorkEventBus from "../projectWork/ProjectWorkEventBus.ts";
import * as ProjectWorkQuery from "../projectWork/ProjectWorkQuery.ts";
import * as ExternalNotificationDispatcher from "./ExternalNotificationDispatcher.ts";

// Only explicit attention-producing causes are supported. Other task changes can
// leave preexisting attention untouched and must not publish it after a restart.
const attentionCause = (
  event: ProjectWorkEvent,
):
  | {
      readonly taskId: ProjectWorkTaskId;
      readonly reason: "blocked" | "failed" | "approval-required" | "stale";
    }
  | undefined => {
  switch (event.type) {
    case "project-work.task.watched":
    case "project-work.task.unwatched":
    case "project-work.task.approved":
      return { taskId: event.taskId, reason: "stale" };
    case "project-work.task.blocked":
      return { taskId: event.taskId, reason: "blocked" };
    case "project-work.task.failed":
      return { taskId: event.taskId, reason: "failed" };
    case "project-work.task.specified":
      return event.specification.protected === true
        ? { taskId: event.taskId, reason: "approval-required" }
        : undefined;
    case "project-work.criterion.waiver-revoked":
    case "project-work.task.specification-protected":
      return { taskId: event.taskId, reason: "approval-required" };
    default:
      return undefined;
  }
};

export class ExternalNotificationRuntime extends Context.Service<
  ExternalNotificationRuntime,
  { readonly start: Effect.Effect<void, never, Scope.Scope> }
>()("t3/notifications/ExternalNotificationRuntime") {}

const messageEventType = {
  completed: "completion",
  failed: "failure",
  cancelled: "cancelled",
  updated: "update",
  unknown: "unknown",
} as const satisfies Record<OrchestrationV2Notification["outcome"], string>;

const threadFactSource = ({ threadId, projectId }: OrchestrationV2DomainEvent) => ({
  threadId,
  ...(projectId === undefined ? {} : { projectId }),
});

const messageFact = (
  event: OrchestrationV2DomainEvent,
  messageId: string,
  notification: Pick<OrchestrationV2Notification, "outcome" | "summary">,
  taskId?: string,
): ExternalNotificationDispatcher.ExternalNotificationFact => ({
  eventType: messageEventType[notification.outcome],
  occurrenceId: JSON.stringify(["message", event.threadId, messageId]),
  legacyIdentity: JSON.stringify(["notification", event.threadId, messageId]),
  ...threadFactSource(event),
  timestamp: DateTime.formatIso(event.occurredAt),
  title: notification.summary.slice(0, 1024),
  ...(taskId === undefined ? {} : { taskId }),
});

const attentionFact = (
  event: ProjectWorkEvent,
  attention: ProjectWorkAttentionRead,
): ExternalNotificationDispatcher.ExternalNotificationFact => {
  const { taskId, reason, revision } = attention;
  const identity = JSON.stringify(["work-attention", event.projectId, taskId, reason, revision]);
  return {
    eventType: "work-attention",
    occurrenceId: identity,
    legacyIdentity: identity,
    projectId: event.projectId,
    taskId,
    timestamp: event.occurredAt,
    title: reason,
    reason,
  };
};

const domainFact = (
  event: OrchestrationV2DomainEvent,
): ExternalNotificationDispatcher.ExternalNotificationFact | undefined => {
  switch (event.type) {
    case "message.updated":
      return event.payload.notification !== undefined && !event.payload.streaming
        ? messageFact(
            event,
            event.payload.id,
            event.payload.notification,
            event.payload.scheduledTaskId,
          )
        : undefined;
    case "turn-item.updated": {
      const item = event.payload;
      if (item.type !== "notification") return;
      if (item.sourceMessageId !== undefined) {
        return { ...messageFact(event, item.sourceMessageId, item), liveOnly: true };
      }
      return {
        eventType: messageEventType[item.outcome],
        occurrenceId: JSON.stringify(["turn-item", event.threadId, item.id]),
        liveOnly: true,
        ...threadFactSource(event),
        timestamp: DateTime.formatIso(event.occurredAt),
        title: item.summary.slice(0, 1024),
      };
    }
    case "runtime-request.updated": {
      const { id, kind, status } = event.payload;
      if (status !== "pending" || kind === "dynamic_tool_call" || kind === "auth_refresh") return;
      const needsInput = kind === "user_input" || kind === "mcp-elicitation";
      return {
        eventType: needsInput ? "needs-input" : "needs-approval",
        occurrenceId: JSON.stringify(["runtime-request", event.threadId, id]),
        legacyIdentity: JSON.stringify(["notification", event.threadId, `runtime-request:${id}`]),
        ...threadFactSource(event),
        timestamp: DateTime.formatIso(event.occurredAt),
        title: needsInput ? "A question needs an answer" : "Approval required",
      };
    }
    case "run.updated": {
      const run = event.payload;
      // The parent reports delegated outcomes through its notification.
      if (run.delegatedTaskId !== undefined || run.startedAt === null || run.completedAt === null)
        return;
      const eventType =
        run.status === "interrupted"
          ? "cancelled"
          : run.status === "completed" || run.status === "failed" || run.status === "cancelled"
            ? messageEventType[run.status]
            : undefined;
      if (eventType === undefined) return;
      return {
        eventType,
        occurrenceId: JSON.stringify(["run", event.threadId, run.id]),
        liveOnly: true,
        ...threadFactSource(event),
        timestamp: DateTime.formatIso(run.completedAt),
        title: `Agent run ${run.status}`,
      };
    }
    default:
      return;
  }
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const bus = yield* ProjectWorkEventBus.ProjectWorkEventBus;
  const queries = yield* ProjectWorkQuery.ProjectWorkQuery;
  const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
  const started = yield* Ref.make(false);
  const workCommitted = Effect.fn("ExternalNotificationRuntime.workCommitted")(function* ({
    event,
  }: ProjectWorkEventBus.ProjectWorkCommittedEvent) {
    if (event.type === "project-work.foundation.recorded") {
      const record = event.record;
      const reason =
        record.kind === "question" && record.status === "pending" && record.seenAt === undefined
          ? "approval-required"
          : record.kind === "gate" && (record.status === "pending" || record.status === "proposed")
            ? "approval-required"
            : record.kind === "review-finding" && record.status === "open"
              ? "needs-review"
              : undefined;
      if (reason === undefined || !("taskId" in record) || record.taskId === undefined) return;
      if ((yield* queries.getProjectRevision(event.projectId)) !== event.revision) return;
      // This adapts the persisted foundation event, not a Work attention row.
      // Its project-global event revision owns the occurrence, avoiding collisions
      // between distinct gates/questions whose record-local revisions are both zero.
      yield* dispatcher.notifyCommitted(
        attentionFact(event, { taskId: record.taskId, reason, revision: event.revision }),
      );
      return;
    }
    const cause = attentionCause(event);
    if (cause === undefined) return;
    // One task has at most one active attention row. Never scan project history.
    const snapshot = yield* queries.withProjectRevision(
      event.projectId,
      queries.listAttention({ projectId: event.projectId, taskId: cause.taskId, limit: 8 }),
    );
    // A coalesced hint may already be behind the projection. Drop it rather than
    // attribute later attention to an earlier commit.
    if (snapshot.revision !== event.revision) return;
    for (const fact of snapshot.value) {
      if (
        fact.reason !== cause.reason ||
        fact.resolvedAt !== undefined ||
        fact.seenAt !== undefined
      )
        continue;
      yield* dispatcher.notifyCommitted(attentionFact(event, fact));
    }
  }, Effect.ignoreCause());
  const start = Effect.fn("ExternalNotificationRuntime.start")(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    const work = yield* bus.subscribe;
    yield* dispatcher.start;
    yield* Stream.runForEach(work, workCommitted).pipe(Effect.ignoreCause, Effect.forkScoped);
    // Orchestrator owns the live-tail cursor; subscribing does not replay stored events.
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.filterMap((event) => {
        const fact = domainFact(event);
        return fact === undefined ? Result.failVoid : Result.succeed(fact);
      }),
      Stream.runForEach(dispatcher.notifyCommitted),
      Effect.ignoreCause,
      Effect.forkScoped,
    );
  });
  return ExternalNotificationRuntime.of({ start: start() });
});
export const layer = Layer.effect(ExternalNotificationRuntime, make);
