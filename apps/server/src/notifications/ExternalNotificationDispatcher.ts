import type { OrchestrationV2Notification, ProjectWorkAttentionRead } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

export type ExternalNotificationFact =
  | {
      readonly kind: "notification";
      readonly messageId: string;
      readonly threadId: string;
      readonly notification: OrchestrationV2Notification;
    }
  | {
      readonly kind: "work-attention";
      readonly projectId: string;
      readonly attention: ProjectWorkAttentionRead;
    };
export interface ExternalNotificationTestResult {
  readonly status: "delivered" | "failed";
  readonly reason?: HomeAssistantWebhookAdapter.ExternalNotificationError["reason"];
}

const factIdentity = (fact: ExternalNotificationFact) =>
  JSON.stringify(
    fact.kind === "notification"
      ? [fact.kind, fact.threadId, fact.messageId]
      : [
          fact.kind,
          fact.projectId,
          fact.attention.taskId,
          fact.attention.reason,
          fact.attention.revision,
        ],
  );
const payload = (
  fact: ExternalNotificationFact,
): HomeAssistantWebhookAdapter.ExternalNotificationPayload =>
  fact.kind === "notification"
    ? {
        schemaVersion: 1,
        test: false,
        kind: fact.kind,
        threadId: fact.threadId,
        title: fact.notification.summary.slice(0, 1024),
      }
    : {
        schemaVersion: 1,
        test: false,
        kind: fact.kind,
        projectId: fact.projectId,
        taskId: fact.attention.taskId,
        title: fact.attention.reason,
      };

export class ExternalNotificationDispatcher extends Context.Service<
  ExternalNotificationDispatcher,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly notifyCommitted: (fact: ExternalNotificationFact) => Effect.Effect<void>;
    readonly test: (destinationId: string) => Effect.Effect<ExternalNotificationTestResult>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/notifications/ExternalNotificationDispatcher") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const adapter = yield* HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter;
  type Pending = {
    readonly identity: string;
    readonly payload: HomeAssistantWebhookAdapter.ExternalNotificationPayload;
  };
  const queue = yield* Queue.dropping<Pending>(64);
  const started = yield* Ref.make(false);
  const dispatch = Effect.fn("ExternalNotificationDispatcher.dispatch")(function* (fact: Pending) {
    const config = yield* settings.getSettings;
    for (const destination of config.externalNotifications.destinations) {
      if (!destination.enabled || !destination.webhookUrl) continue;
      yield* Effect.gen(function* () {
        // Claim before I/O. A crash or ambiguous network failure must not replay a webhook.
        const claimed =
          yield* sql`INSERT INTO t3_workflow_v2_external_notifications (fact_id,destination_id,status)
          VALUES (${fact.identity},${destination.id},'uncertain') ON CONFLICT DO NOTHING RETURNING fact_id`;
        if (claimed.length === 0) return;
        const sent = yield* Effect.exit(adapter.send(destination.webhookUrl, fact.payload));
        yield* sql`UPDATE t3_workflow_v2_external_notifications SET status=${sent._tag === "Success" ? "delivered" : "uncertain"}
          WHERE fact_id=${fact.identity} AND destination_id=${destination.id}`;
      }).pipe(Effect.ignoreCause);
    }
  });
  const safeDispatch = (fact: Pending) => dispatch(fact).pipe(Effect.ignoreCause);
  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    yield* Queue.take(queue).pipe(Effect.flatMap(safeDispatch), Effect.forever, Effect.forkScoped);
  });
  const test = Effect.fn("ExternalNotificationDispatcher.test")(
    function* (destinationId: string) {
      const config = yield* settings.getSettings;
      const destination = config.externalNotifications.destinations.find(
        (candidate) => candidate.id === destinationId,
      );
      if (!destination?.webhookUrl) return { status: "failed", reason: "unconfigured" } as const;
      return yield* adapter
        .send(destination.webhookUrl, {
          schemaVersion: 1,
          test: true,
          kind: "test",
          title: "T3 Code test notification",
        })
        .pipe(
          Effect.as({ status: "delivered" } as const),
          Effect.catch((error) =>
            Effect.succeed({ status: "failed", reason: error.reason } as const),
          ),
        );
    },
    Effect.catchCause(() => Effect.succeed({ status: "failed", reason: "transport" } as const)),
  );
  return ExternalNotificationDispatcher.of({
    start,
    notifyCommitted: Effect.fn("ExternalNotificationDispatcher.notifyCommitted")(
      (fact: ExternalNotificationFact) => {
        if (fact.kind === "work-attention" && (fact.attention.resolvedAt || fact.attention.seenAt))
          return Effect.void;
        // Retain only the bounded outbound payload, never the persisted detail or source metadata.
        return Queue.offer(queue, { identity: factIdentity(fact), payload: payload(fact) }).pipe(
          Effect.asVoid,
        );
      },
    ),
    test,
    // Used by deterministic tests before the background consumer starts.
    drain: Effect.suspend(() =>
      Queue.sizeUnsafe(queue) === 0
        ? Effect.void
        : Queue.takeAll(queue).pipe(
            Effect.flatMap((facts) => Effect.forEach(facts, safeDispatch, { discard: true })),
          ),
    ),
  });
});
export const layer = Layer.effect(ExternalNotificationDispatcher, make);
