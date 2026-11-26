import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
  DEFAULT_SERVER_SETTINGS,
  type ExternalNotificationDestination,
} from "@t3tools/contracts";
import { ExternalNotificationError } from "@t3tools/external-notifications/webhook";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { mapSettingsSecrets, SECRET_REDACTED } from "../settingsSecrets.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { runWorkflowFeatureMigrations } from "../persistence/WorkflowFeatureMigrations.ts";
import { workflowFeatureMigrations } from "../persistence/WorkflowFeatureSchema.ts";
import * as Transport from "./ExternalNotificationTransport.ts";
import {
  notificationEnvironment,
  type NotificationSample,
} from "./externalNotificationTestFixtures.ts";
import * as Dispatcher from "./ExternalNotificationDispatcher.ts";

const destination: ExternalNotificationDestination = {
  id: "ha",
  name: "Home",
  kind: "home-assistant" as const,
  enabled: true,
  webhookUrl: "https://home.test/api/webhook/SECRET",
};
const timestamp = "2026-06-01T00:00:00.000Z";
const fact = (messageId: string): Dispatcher.ExternalNotificationFact => ({
  eventType: "completion",
  occurrenceId: JSON.stringify(["message", "thread", messageId]),
  legacyIdentity: JSON.stringify(["notification", "thread", messageId]),
  threadId: "thread",
  timestamp,
  title: "Done",
});
const attention = (revision: number): Dispatcher.ExternalNotificationFact => {
  const identity = JSON.stringify(["work-attention", "project", "task", "blocked", revision]);
  return {
    eventType: "work-attention",
    occurrenceId: identity,
    legacyIdentity: identity,
    projectId: "project",
    taskId: "task",
    reason: "blocked",
    timestamp,
    title: "blocked",
  };
};
const dispatcherLayer = (
  send: Transport.ExternalNotificationTransport["Service"]["send"],
  destinations: ReadonlyArray<ExternalNotificationDestination> = [destination],
  environment = notificationEnvironment(),
) =>
  Layer.fresh(Dispatcher.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Settings.ServerSettingsService.layerTest({ externalNotifications: { destinations } }),
        Layer.succeed(Transport.ExternalNotificationTransport, { send }),
        environment,
      ),
    ),
  );
const setup = (...args: Parameters<typeof dispatcherLayer>) =>
  dispatcherLayer(...args).pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("defaults off; installation and unconfigured test send nothing", () => {
  let sends = 0;
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* dispatcher.notifyCommitted(fact("1"));
    yield* dispatcher.drain;
    expect(yield* dispatcher.test("ha")).toEqual({ status: "failed", reason: "unconfigured" });
    expect(sends).toBe(0);
    expect(DEFAULT_SERVER_SETTINGS.externalNotifications.destinations).toEqual([]);
  }).pipe(
    Effect.provide(
      setup(
        () =>
          Effect.sync(() => {
            sends++;
          }),
        [],
      ),
    ),
  );
});
it.effect("bounds pending work and durably suppresses duplicate attempts", () => {
  let sends = 0;
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    for (let i = 0; i < 70; i++) yield* dispatcher.notifyCommitted(fact(String(i)));
    yield* dispatcher.drain;
    expect(sends).toBe(64);
    yield* dispatcher.notifyCommitted(fact("0"));
    yield* dispatcher.drain;
    expect(sends).toBe(64);
    const sql = yield* SqlClient.SqlClient;
    expect(
      (yield* sql`SELECT * FROM t3_workflow_v2_external_notification_occurrences`).length,
    ).toBe(64);
  }).pipe(
    Effect.provide(
      setup(() =>
        Effect.sync(() => {
          sends++;
        }),
      ),
    ),
  );
});
it.effect("isolates a failing destination and never retries an uncertain attempt", () => {
  const sent: string[] = [];
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* dispatcher.notifyCommitted(fact("1"));
    yield* dispatcher.drain;
    yield* dispatcher.notifyCommitted(fact("1"));
    yield* dispatcher.drain;
    expect(sent).toEqual([
      destination.webhookUrl,
      "https://rejected.test/webhook",
      "https://second.test/webhook",
    ]);
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql`SELECT status FROM t3_workflow_v2_external_notification_occurrences ORDER BY destination_id`,
    ).toEqual([{ status: "uncertain" }, { status: "failed" }, { status: "delivered" }]);
  }).pipe(
    Effect.provide(
      setup(
        ({ webhookUrl, id }) =>
          Effect.gen(function* () {
            sent.push(webhookUrl);
            if (id === "ha") return yield* new ExternalNotificationError({ reason: "transport" });
            if (id === "rejected")
              return yield* new ExternalNotificationError({
                reason: "transport",
                knownFailure: true,
              });
          }),
        [
          destination,
          { ...destination, id: "rejected", webhookUrl: "https://rejected.test/webhook" },
          { ...destination, id: "second", webhookUrl: "https://second.test/webhook" },
        ],
      ),
    ),
  );
});
it.effect("preserves delivered and uncertain claims from the previous database schema", () => {
  const sent: string[] = [];
  return Effect.gen(function* () {
    yield* runMigrations();
    yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, -1));
    const sql = yield* SqlClient.SqlClient;
    for (const [legacy, status] of [
      [["notification", "thread", "old-message"], "delivered"],
      [["notification", "thread", "runtime-request:old-request"], "uncertain"],
      [["work-attention", "project", "task", "blocked", 1], "delivered"],
    ] as const) {
      yield* sql`INSERT INTO t3_workflow_v2_external_notifications (fact_id,destination_id,status)
        VALUES (${JSON.stringify(legacy)},${destination.id},${status})`;
    }
    yield* runWorkflowFeatureMigrations();
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* dispatcher.notifyCommitted(fact("old-message"));
    yield* dispatcher.notifyCommitted({
      ...fact("runtime-request:old-request"),
      occurrenceId: JSON.stringify(["runtime-request", "thread", "old-request"]),
      eventType: "needs-input",
    });
    yield* dispatcher.notifyCommitted(attention(1));
    yield* dispatcher.notifyCommitted(fact("new-message"));
    yield* dispatcher.drain;
    expect(sent).toEqual([destination.webhookUrl]);
    expect(
      yield* sql`SELECT environment_id, destination_id, status
      FROM t3_workflow_v2_external_notification_occurrences`,
    ).toEqual([{ environment_id: "test-environment", destination_id: "ha", status: "delivered" }]);
  }).pipe(
    Effect.provide(
      dispatcherLayer(({ webhookUrl }) =>
        Effect.sync(() => {
          sent.push(webhookUrl);
        }),
      ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});
it.effect("explicit test sends to a configured disabled destination", () => {
  const payloads: NotificationSample[] = [];
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    expect(yield* dispatcher.test("ha")).toEqual({ status: "delivered" });
    expect(payloads).toEqual([
      expect.objectContaining({
        eventType: "test",
        title: "T3 Code test notification",
        environmentId: "test-environment",
        environmentName: "test-environment",
      }),
    ]);
  }).pipe(
    Effect.provide(
      setup(
        (_url, payload) =>
          Effect.sync(() => {
            payloads.push(payload);
          }),
        [{ ...destination, enabled: false, events: [] }],
        notificationEnvironment(Effect.succeed("")),
      ),
    ),
  );
});
it("maps webhook secrets through the existing redaction lifecycle", () => {
  const input = {
    ...DEFAULT_SERVER_SETTINGS,
    externalNotifications: { destinations: [destination] },
  };
  const secrets: string[] = [];
  const redacted = mapSettingsSecrets(input, (secret) => {
    secrets.push(secret.secretName);
    return { value: "", redacted: true };
  });
  expect(secrets).toContain("notification-webhook-aGE");
  expect(redacted.externalNotifications.destinations[0]?.webhookUrl).toBe(SECRET_REDACTED);
  expect(JSON.stringify(redacted)).not.toContain("SECRET");
});

it.effect("the scoped worker consumes committed facts without a drain", () =>
  Effect.gen(function* () {
    const delivered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
      yield* dispatcher.start;
      yield* dispatcher.start;
      yield* dispatcher.notifyCommitted(fact("worker"));
      yield* Deferred.await(delivered);
    }).pipe(
      Effect.provide(setup(() => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid))),
    );
  }).pipe(Effect.scoped),
);

it.effect("live-only traffic leaves room for legacy Home Assistant notifications", () => {
  const events: string[] = [];
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* Effect.forEach(
      Array.from({ length: 64 }, (_, index) => ({
        ...fact(`generic-${index}`),
        liveOnly: true,
      })),
      dispatcher.notifyCommitted,
      { discard: true },
    );
    yield* dispatcher.notifyCommitted(fact("legacy"));
    yield* dispatcher.drain;
    expect(events).toEqual([fact("legacy").occurrenceId]);
  }).pipe(
    Effect.provide(
      setup((_, event) =>
        Effect.sync(() => {
          events.push(event.occurrenceId);
        }),
      ),
    ),
  );
});

it.effect("Home Assistant matches live occurrences only with explicit filters", () => {
  const sent: string[] = [];
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* dispatcher.notifyCommitted({ ...fact("standalone"), liveOnly: true });
    yield* dispatcher.notifyCommitted({ ...fact("two-forms"), title: "Message" });
    yield* dispatcher.notifyCommitted({ ...fact("two-forms"), title: "Mirror", liveOnly: true });
    yield* dispatcher.notifyCommitted({
      ...fact("terminal"),
      title: "Terminal notice",
      liveOnly: true,
    });
    yield* dispatcher.notifyCommitted({ ...fact("terminal"), title: "Terminal wake" });
    yield* dispatcher.drain;
    expect(sent).toEqual([
      "explicit/Done",
      "ha/Message",
      "explicit/Message",
      "explicit/Terminal notice",
      "ha/Terminal wake",
    ]);
  }).pipe(
    Effect.provide(
      setup(
        ({ id }, { title }) => Effect.sync(() => void sent.push(`${id}/${title}`)),
        [
          destination,
          { ...destination, id: "explicit", events: DEFAULT_EXTERNAL_NOTIFICATION_EVENTS },
          { ...destination, id: "empty", events: [] },
          { ...destination, id: "different", events: ["failure"] },
        ],
      ),
    ),
  );
});

it.effect("competing dispatchers claim once per environment and destination", () => {
  const sources: string[] = [];
  const send: Transport.ExternalNotificationTransport["Service"]["send"] = (_, event) =>
    Effect.sync(() => {
      sources.push(event.environmentId);
    });
  return Effect.gen(function* () {
    const first = yield* Dispatcher.ExternalNotificationDispatcher;
    const second = yield* Dispatcher.ExternalNotificationDispatcher.pipe(
      Effect.provide(dispatcherLayer(send)),
    );
    const otherEnvironment = yield* Dispatcher.ExternalNotificationDispatcher.pipe(
      Effect.provide(
        dispatcherLayer(
          send,
          [destination],
          notificationEnvironment(Effect.succeed("Another"), "another"),
        ),
      ),
    );
    yield* first.notifyCommitted(fact("same"));
    yield* second.notifyCommitted(fact("same"));
    yield* Effect.all([first.drain, second.drain], { concurrency: "unbounded" });
    yield* otherEnvironment.notifyCommitted(fact("same"));
    yield* otherEnvironment.drain;
    expect(sources).toEqual(["test-environment", "another"]);
  }).pipe(Effect.provide(setup(send)));
});

it.effect(
  "persists webhook URLs only in ServerSecretStore, preserves redacted echoes, and removes stale secrets",
  () =>
    Effect.gen(function* () {
      const service = yield* Settings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* ServerSecretStore.ServerSecretStore;
      const saved = yield* service.updateSettings({
        externalNotifications: { destinations: [destination] },
      });
      expect(saved.externalNotifications.destinations[0]?.webhookUrl).toBe(destination.webhookUrl);
      const client = Settings.redactServerSettingsForClient(saved, { secretReferences: true });
      expect(client.externalNotifications.destinations[0]?.webhookUrl).toBe(SECRET_REDACTED);
      expect(yield* fs.readFileString(config.settingsPath)).not.toContain(destination.webhookUrl);
      const stored = yield* store.get("notification-webhook-aGE");
      expect(Option.isSome(stored)).toBe(true);
      const echoed = yield* service.updateSettings({
        externalNotifications: client.externalNotifications,
      });
      expect(echoed.externalNotifications.destinations[0]?.webhookUrl).toBe(destination.webhookUrl);
      yield* service.updateSettings({ externalNotifications: { destinations: [] } });
      expect(Option.isNone(yield* store.get("notification-webhook-aGE"))).toBe(true);
    }).pipe(
      Effect.provide(
        Settings.layer.pipe(
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-notifications-test-" }),
          ),
          Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect("independent filters use the source name captured when work was queued", () =>
  Effect.gen(function* () {
    const name = yield* Ref.make("Original");
    const sent: Array<{ id: string; event: NotificationSample }> = [];
    const first = {
      ...destination,
      kind: "generic-webhook" as const,
      events: ["completion"] as const,
    };
    const second = { ...first, id: "attention", events: ["work-attention"] as const };
    const both = { ...first, id: "both", events: ["completion", "work-attention"] as const };
    const none = { ...first, id: "none", events: [] };
    yield* Effect.gen(function* () {
      const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
      yield* dispatcher.notifyCommitted(fact("1"));
      yield* dispatcher.notifyCommitted(attention(1));
      yield* Ref.set(name, "Renamed");
      yield* dispatcher.notifyCommitted(attention(2));
      yield* dispatcher.drain;
    }).pipe(
      Effect.provide(
        setup(
          ({ id }, event) =>
            Effect.sync(() => {
              sent.push({ id, event });
            }),
          [first, second, both, none],
          notificationEnvironment(Ref.get(name)),
        ),
      ),
    );
    expect(
      sent.map(({ id, event }) => [
        id,
        event.eventType,
        event.environmentId,
        event.environmentName,
      ]),
    ).toEqual([
      ["ha", "completion", "test-environment", "Original"],
      ["both", "completion", "test-environment", "Original"],
      ["attention", "work-attention", "test-environment", "Original"],
      ["both", "work-attention", "test-environment", "Original"],
      ["attention", "work-attention", "test-environment", "Renamed"],
      ["both", "work-attention", "test-environment", "Renamed"],
    ]);
  }),
);
