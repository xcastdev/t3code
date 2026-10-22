import { assert, it } from "@effect/vitest";
import { AuthSessionId, AuthSettingsWriteScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Gateway from "../notifications/ExternalNotificationGateway.ts";
import * as Dispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import { layerControlledFreshSecrets } from "./controlledUpgradeApp.ts";
import {
  controlledNotificationDestinationId,
  ControlledNotificationReceipts,
  layerControlledNotificationPorts,
  layerControlledNotifications,
} from "./controlledNotifications.ts";

it.effect(
  "delivers an authorized disabled-destination human test only to the private fake adapter",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.AuthSessionRepository;
      const now = yield* DateTime.now;
      const writer = AuthSessionId.make("fixture-settings-writer");
      const reader = AuthSessionId.make("fixture-settings-reader");
      for (const sessionId of [writer, reader])
        yield* sessions.create({
          sessionId,
          subject: "fixture",
          scopes: sessionId === writer ? [AuthSettingsWriteScope] : [],
          method: "browser-session-cookie",
          issuedAt: now,
          expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "unknown",
            os: null,
            browser: null,
          },
        });
      const gateway = yield* Gateway.ExternalNotificationGateway;
      const receipts = yield* ControlledNotificationReceipts;
      const settings = yield* Settings.ServerSettingsService;
      const destination = (yield* settings.getSettings).externalNotifications.destinations[0]!;
      assert.isFalse(destination.enabled);
      assert.equal(
        (yield* gateway
          .test({ destinationId: controlledNotificationDestinationId }, reader)
          .pipe(Effect.flip)).requiredPermission,
        AuthSettingsWriteScope,
      );
      assert.equal((yield* receipts.received).length, 0);
      assert.deepEqual(
        yield* gateway.test({ destinationId: controlledNotificationDestinationId }, writer),
        { status: "delivered" },
      );
      assert.deepEqual(yield* receipts.received, [{ kind: "test", test: true }]);
      yield* sessions.revoke({ sessionId: writer, revokedAt: now });
      assert.equal(
        (yield* gateway
          .test({ destinationId: controlledNotificationDestinationId }, writer)
          .pipe(Effect.flip)).requiredPermission,
        AuthSettingsWriteScope,
      );
      const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
      const fact: Dispatcher.ExternalNotificationFact = {
        kind: "notification",
        messageId: "fixture-fact",
        threadId: "fixture-thread",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Private fixture detail",
        },
      };
      yield* dispatcher.notifyCommitted(fact);
      yield* dispatcher.drain;
      assert.equal((yield* receipts.received).length, 1);
      yield* settings.updateSettings({
        externalNotifications: { destinations: [{ ...destination, enabled: true }] },
      });
      yield* dispatcher.notifyCommitted(fact);
      yield* dispatcher.notifyCommitted(fact);
      yield* dispatcher.drain;
      assert.deepEqual(yield* receipts.received, [
        { kind: "test", test: true },
        { kind: "notification", test: false },
      ]);
      yield* settings.updateSettings({
        externalNotifications: {
          destinations: [
            { ...destination, webhookUrl: "https://outside.invalid/api/webhook/rejected" },
          ],
        },
      });
      assert.deepEqual(yield* dispatcher.test(controlledNotificationDestinationId), {
        status: "failed",
        reason: "unconfigured",
      });
      assert.equal((yield* receipts.received).length, 2);
    }).pipe(
      Effect.provide(
        layerControlledNotifications.pipe(
          Layer.provideMerge(
            layerControlledNotificationPorts.pipe(Layer.provide(layerControlledFreshSecrets)),
          ),
          Layer.provideMerge(Sessions.layer),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    ),
);
