import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { mapSettingsSecrets, SECRET_REDACTED } from "../settingsSecrets.ts";
import { externalNotificationMigration } from "../persistence/ExternalNotificationMigration.ts";
import * as Adapter from "./HomeAssistantWebhookAdapter.ts";
import * as Dispatcher from "./ExternalNotificationDispatcher.ts";

const destination = {
  id: "ha",
  name: "Home",
  kind: "home-assistant" as const,
  enabled: true,
  webhookUrl: "https://home.test/api/webhook/SECRET",
};
const fact = (messageId: string): Dispatcher.ExternalNotificationFact => ({
  kind: "notification",
  messageId,
  threadId: "thread",
  notification: { source: { kind: "background_task" }, outcome: "completed", summary: "Done" },
});
const setup = (
  send: Adapter.HomeAssistantWebhookAdapter["Service"]["send"],
  destinations = [destination],
) =>
  Dispatcher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Settings.ServerSettingsService.layerTest({ externalNotifications: { destinations } }),
        Layer.succeed(Adapter.HomeAssistantWebhookAdapter, { send }),
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
  );
const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of externalNotificationMigration.statements)
    yield* sql.unsafe(statement.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
});
it.effect("defaults off; installation and unconfigured test send nothing", () => {
  let sends = 0;
  return Effect.gen(function* () {
    yield* schema;
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
    yield* schema;
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    for (let i = 0; i < 70; i++) yield* dispatcher.notifyCommitted(fact(String(i)));
    yield* dispatcher.drain;
    expect(sends).toBe(64);
    yield* dispatcher.notifyCommitted(fact("0"));
    yield* dispatcher.drain;
    expect(sends).toBe(64);
    const sql = yield* SqlClient.SqlClient;
    expect((yield* sql`SELECT * FROM t3_workflow_v2_external_notifications`).length).toBe(64);
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
    yield* schema;
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* dispatcher.notifyCommitted(fact("1"));
    yield* dispatcher.drain;
    yield* dispatcher.notifyCommitted(fact("1"));
    yield* dispatcher.drain;
    expect(sent).toEqual([destination.webhookUrl, "https://second.test/webhook"]);
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql`SELECT status FROM t3_workflow_v2_external_notifications ORDER BY destination_id`,
    ).toEqual([{ status: "uncertain" }, { status: "delivered" }]);
  }).pipe(
    Effect.provide(
      setup(
        (url) =>
          Effect.gen(function* () {
            sent.push(url);
            if (url === destination.webhookUrl)
              return yield* new Adapter.ExternalNotificationError({ reason: "transport" });
          }),
        [destination, { ...destination, id: "second", webhookUrl: "https://second.test/webhook" }],
      ),
    ),
  );
});
it.effect("explicit test sends to a configured disabled destination", () => {
  const payloads: Adapter.ExternalNotificationPayload[] = [];
  return Effect.gen(function* () {
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    expect(yield* dispatcher.test("ha")).toEqual({ status: "delivered" });
    expect(payloads).toEqual([
      { schemaVersion: 1, test: true, kind: "test", title: "T3 Code test notification" },
    ]);
  }).pipe(
    Effect.provide(
      setup(
        (_url, payload) =>
          Effect.sync(() => {
            payloads.push(payload);
          }),
        [{ ...destination, enabled: false }],
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
      yield* schema;
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

it.effect("a new dispatcher over the same database does not repeat a claimed fact", () => {
  let sends = 0;
  const send = () =>
    Effect.sync(() => {
      sends++;
    });
  const fresh = Dispatcher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Settings.ServerSettingsService.layerTest({
          externalNotifications: { destinations: [destination] },
        }),
        Layer.succeed(Adapter.HomeAssistantWebhookAdapter, { send }),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* schema;
    const first = yield* Dispatcher.ExternalNotificationDispatcher;
    yield* first.notifyCommitted(fact("restart"));
    yield* first.drain;
    const second = yield* Dispatcher.ExternalNotificationDispatcher.pipe(Effect.provide(fresh));
    yield* second.notifyCommitted(fact("restart"));
    yield* second.drain;
    expect(sends).toBe(1);
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
      const client = Settings.redactServerSettingsForClient(saved);
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
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-notifications-test-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("attention revisions are separate facts and seen attention never sends", () => {
  const payloads: Adapter.ExternalNotificationPayload[] = [];
  return Effect.gen(function* () {
    yield* schema;
    const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
    const attention = {
      taskId: ProjectWorkTaskId.make("task"),
      reason: "blocked",
      revision: 1,
    } as const;
    yield* dispatcher.notifyCommitted({ kind: "work-attention", projectId: "project", attention });
    yield* dispatcher.drain;
    yield* dispatcher.notifyCommitted({ kind: "work-attention", projectId: "project", attention });
    yield* dispatcher.notifyCommitted({
      kind: "work-attention",
      projectId: "project",
      attention: { ...attention, revision: 2 },
    });
    yield* dispatcher.notifyCommitted({
      kind: "work-attention",
      projectId: "project",
      attention: { ...attention, revision: 3, seenAt: "2026-01-01T00:00:00.000Z" },
    });
    yield* dispatcher.drain;
    expect(payloads.length).toBe(2);
    expect(payloads[0]).toEqual({
      schemaVersion: 1,
      test: false,
      kind: "work-attention",
      projectId: "project",
      taskId: "task",
      title: "blocked",
    });
  }).pipe(
    Effect.provide(
      setup((_url, payload) =>
        Effect.sync(() => {
          payloads.push(payload);
        }),
      ),
    ),
  );
});
