import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import {
  DesktopAttachPairingUrlError,
  resolveDesktopAttachPairingTarget,
} from "./DesktopAttachedBackend.ts";
import * as DesktopAttachedBackend from "./DesktopAttachedBackend.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";

describe("DesktopAttachedBackend", () => {
  it.effect("accepts only loopback HTTP pairing URLs and normalizes their targets", () =>
    Effect.gen(function* () {
      const target = yield* resolveDesktopAttachPairingTarget(
        "http://127.0.0.9:4100/pair#token=owner-token",
      );
      assert.equal(target.credential, "owner-token");
      assert.equal(target.httpBaseUrl, "http://127.0.0.9:4100/");
      assert.equal(target.wsBaseUrl, "ws://127.0.0.9:4100/");
    }),
  );

  it.effect("rejects remote, secure, and ambiguous pairing links", () =>
    Effect.gen(function* () {
      for (const pairingUrl of [
        "http://192.168.1.5:4100/pair#token=owner-token",
        "https://127.0.0.1:4100/pair#token=owner-token",
        "http://127.0.0.1:4100/pair?token=one#token=two",
        "http://127.0.0.1:4100/pair#token=owner-token&scope=all",
      ]) {
        const error = yield* resolveDesktopAttachPairingTarget(pairingUrl).pipe(Effect.flip);
        assert.instanceOf(error, DesktopAttachPairingUrlError);
        assert.notInclude(error.message, "owner-token");
      }
    }),
  );

  it.effect("does not decrypt or contact an endpoint rejected at the settings boundary", () =>
    Effect.gen(function* () {
      const decrypt = { count: 0 };
      const request = { count: 0 };
      const invalidPreference = DesktopAppSettings.normalizePrimaryBackendPreference(
        {
          mode: "attached",
          httpBaseUrl: "http://example.test:4100/",
          wsBaseUrl: "ws://example.test:4100/",
          environmentId: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Workstation",
          encryptedBearerToken: "ciphertext",
          bearerExpiresAt: "2099-09-08T18:00:00.000Z",
        },
        Date.parse("2026-09-08T12:00:00.000Z"),
      );
      const settingsLayer = DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        primaryBackend: invalidPreference,
      });
      const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
        isEncryptionAvailable: Effect.succeed(true),
        encryptString: () => Effect.succeed(new Uint8Array()),
        decryptString: () =>
          Effect.sync(() => {
            decrypt.count += 1;
            return "should-not-be-read";
          }),
        selectedStorageBackend: Effect.succeed(Option.none()),
      } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]);
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.sync(() => {
            request.count += 1;
          }).pipe(Effect.andThen(Effect.die("unexpected HTTP request"))),
        ),
      );
      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        appVersion: "0.0.17",
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const layer = DesktopAttachedBackend.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            settingsLayer,
            safeStorageLayer,
            httpClientLayer,
            environmentLayer,
            poolLayer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
        const bearer = yield* Effect.exit(attached.getBearerToken);
        const probe = yield* Effect.exit(attached.probe);

        assert.equal(bearer._tag, "Failure");
        assert.equal(probe._tag, "Failure");
        assert.equal(decrypt.count, 0);
        assert.equal(request.count, 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
