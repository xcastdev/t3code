import type { ProjectWorkTaskId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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
      yield* dispatcher.notifyCommitted({
        kind: "work-attention",
        projectId: event.projectId,
        attention: { taskId: record.taskId, reason, revision: event.revision },
      });
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
      yield* dispatcher.notifyCommitted({
        kind: "work-attention",
        projectId: event.projectId,
        attention: fact,
      });
    }
  }, Effect.ignoreCause());
  const start = Effect.fn("ExternalNotificationRuntime.start")(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    const work = yield* bus.subscribe;
    yield* dispatcher.start;
    yield* Stream.runForEach(work, workCommitted).pipe(Effect.ignoreCause, Effect.forkScoped);
    // Orchestrator owns the live-tail cursor; subscribing does not replay stored events.
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.buffer({ capacity: 64, strategy: "dropping" }),
      Stream.runForEach((event) => {
        if (
          event.type === "runtime-request.updated" &&
          event.payload.status === "pending" &&
          event.payload.kind !== "dynamic_tool_call" &&
          event.payload.kind !== "auth_refresh"
        ) {
          return dispatcher
            .notifyCommitted({
              kind: "notification",
              threadId: event.threadId,
              messageId: `runtime-request:${event.payload.id}`,
              notification: {
                source: { kind: "background_task" },
                outcome: "updated",
                summary:
                  event.payload.kind === "user_input" || event.payload.kind === "mcp-elicitation"
                    ? "A question needs an answer"
                    : "Approval required",
              },
            })
            .pipe(Effect.ignoreCause);
        }
        return event.type === "message.updated" &&
          event.payload.notification !== undefined &&
          !event.payload.streaming
          ? dispatcher
              .notifyCommitted({
                kind: "notification",
                threadId: event.payload.threadId,
                messageId: event.payload.id,
                notification: event.payload.notification,
              })
              .pipe(Effect.ignoreCause)
          : Effect.void;
      }),
      Effect.ignoreCause,
      Effect.forkScoped,
    );
  });
  return ExternalNotificationRuntime.of({ start: start() });
});
export const layer = Layer.effect(ExternalNotificationRuntime, make);
