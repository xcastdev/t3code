import { expect, it } from "@effect/vitest";
import { AuthSessionId, AuthSettingsWriteScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Adapter from "./HomeAssistantWebhookAdapter.ts";
import * as Dispatcher from "./ExternalNotificationDispatcher.ts";
import * as Gateway from "./ExternalNotificationGateway.ts";

const setup = (sent: Adapter.ExternalNotificationPayload[]) =>
  Gateway.layer.pipe(
    Layer.provideMerge(Sessions.layer),
    Layer.provide(
      Dispatcher.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Settings.ServerSettingsService.layerTest({
              externalNotifications: {
                destinations: [
                  {
                    id: "ha",
                    name: "Home",
                    kind: "home-assistant",
                    enabled: false,
                    webhookUrl: "https://home.test/api/webhook/PRIVATE",
                  },
                ],
              },
            }),
            Layer.succeed(Adapter.HomeAssistantWebhookAdapter, {
              send: (_url, payload) =>
                Effect.sync(() => {
                  sent.push(payload);
                }),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(Sqlite.layerMemory),
  );
const sessionInput = (
  sessionId: AuthSessionId,
  now: DateTime.Utc,
): Sessions.CreateAuthSessionInput => ({
  sessionId,
  subject: "maintainer",
  scopes: [AuthSettingsWriteScope],
  method: "browser-session-cookie",
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "unknown",
    os: null,
    browser: null,
  },
  issuedAt: now,
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
});

it.effect("tests a saved disabled destination, then refuses the same revoked session", () => {
  const sent: Adapter.ExternalNotificationPayload[] = [];
  const sessionId = AuthSessionId.make("notification-test");
  return Effect.gen(function* () {
    const sessions = yield* Sessions.AuthSessionRepository;
    const now = yield* DateTime.now;
    yield* sessions.create(sessionInput(sessionId, now));
    const gateway = yield* Gateway.ExternalNotificationGateway;
    expect(yield* gateway.test({ destinationId: "ha" }, sessionId)).toEqual({
      status: "delivered",
    });
    expect(sent).toEqual([
      { schemaVersion: 1, test: true, kind: "test", title: "T3 Code test notification" },
    ]);
    yield* sessions.revoke({ sessionId, revokedAt: now });
    expect(yield* gateway.test({ destinationId: "ha" }, sessionId).pipe(Effect.flip)).toMatchObject(
      {
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthSettingsWriteScope,
      },
    );
    expect(sent).toHaveLength(1);
  }).pipe(Effect.provide(setup(sent)));
});

it.effect("missing, expired, and settings-read-only sessions cannot send externally", () => {
  const sent: Adapter.ExternalNotificationPayload[] = [];
  return Effect.gen(function* () {
    const sessions = yield* Sessions.AuthSessionRepository;
    const now = yield* DateTime.now;
    const expired = AuthSessionId.make("expired");
    const readOnly = AuthSessionId.make("read-only");
    yield* sessions.create({ ...sessionInput(expired, now), expiresAt: now });
    yield* sessions.create({ ...sessionInput(readOnly, now), scopes: [] });
    const gateway = yield* Gateway.ExternalNotificationGateway;
    for (const sessionId of [AuthSessionId.make("missing"), expired, readOnly]) {
      const error = yield* gateway.test({ destinationId: "ha" }, sessionId).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthSettingsWriteScope,
      });
      expect(JSON.stringify(error)).not.toContain("PRIVATE");
    }
    expect(sent).toEqual([]);
  }).pipe(Effect.provide(setup(sent)));
});

it.effect("an authorized test returns only a safe status for an unconfigured destination", () => {
  const sent: Adapter.ExternalNotificationPayload[] = [];
  const sessionId = AuthSessionId.make("notification-test");
  return Effect.gen(function* () {
    const sessions = yield* Sessions.AuthSessionRepository;
    yield* sessions.create(sessionInput(sessionId, yield* DateTime.now));
    const gateway = yield* Gateway.ExternalNotificationGateway;
    expect(yield* gateway.test({ destinationId: "missing" }, sessionId)).toEqual({
      status: "failed",
      reason: "unconfigured",
    });
    expect(sent).toEqual([]);
  }).pipe(Effect.provide(setup(sent)));
});
