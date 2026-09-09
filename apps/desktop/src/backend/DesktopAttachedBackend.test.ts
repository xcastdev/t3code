import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type EnvironmentId,
} from "@t3tools/contracts";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  DesktopAttachPairingUrlError,
  resolveDesktopAttachPairingTarget,
} from "./DesktopAttachedBackend.ts";
import * as DesktopAttachedBackend from "./DesktopAttachedBackend.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";

const ATTACHED_HTTP_BASE_URL = "http://127.0.0.1:4100/";
const ATTACHED_WS_BASE_URL = "ws://127.0.0.1:4100/";
const primaryEnvironmentId = PRIMARY_LOCAL_ENVIRONMENT_ID as EnvironmentId;

const descriptorFor = (environmentId = PRIMARY_LOCAL_ENVIRONMENT_ID) => ({
  environmentId,
  label: "Workstation",
  platform: { os: "darwin", arch: "x64" },
  serverVersion: "0.0.17",
  capabilities: { repositoryIdentity: false },
});

const administrativeToken = (scope = AuthAdministrativeScopes.join(" ")) => ({
  access_token: "replacement-access-token",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope,
});

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function makeRefreshHarness(
  responses: ReadonlyArray<{ readonly body: unknown; readonly status?: number }>,
) {
  const requestUrls: Array<string> = [];
  let responseIndex = 0;
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);
        const response = responses[responseIndex++];
        if (response === undefined) throw new Error(`Unexpected request: ${request.url}`);
        return jsonResponse(request, response.body, response.status);
      }),
    ),
  );

  const initialSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    primaryBackend: {
      mode: "attached" as const,
      httpBaseUrl: ATTACHED_HTTP_BASE_URL,
      wsBaseUrl: ATTACHED_WS_BASE_URL,
      environmentId: primaryEnvironmentId,
      label: "Original workstation",
      encryptedBearerToken: "b2xkLWVuY3J5cHRlZC10b2tlbg==",
      bearerExpiresAt: "2099-09-08T18:00:00.000Z",
    },
  };
  const settingsLayer = DesktopAppSettings.layerTest(initialSettings);
  const encryptedCredentials: Array<string> = [];
  const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (credential: string) =>
      Effect.sync(() => {
        encryptedCredentials.push(credential);
        return new TextEncoder().encode(`encrypted:${credential}`);
      }),
    decryptString: () => Effect.succeed("stored-bearer-token"),
    selectedStorageBackend: Effect.succeed(Option.none()),
  } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]);
  const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform: "darwin",
    appVersion: "0.0.17",
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  const dependencies = Layer.mergeAll(
    settingsLayer,
    safeStorageLayer,
    httpClientLayer,
    environmentLayer,
    poolLayer,
  );
  const layer = Layer.mergeAll(
    DesktopAttachedBackend.layer.pipe(Layer.provide(dependencies)),
    settingsLayer,
  );

  return { layer, encryptedCredentials, requestUrls, initialSettings };
}

function makeAttachHarness(
  responses: ReadonlyArray<{ readonly body: unknown; readonly status?: number }>,
  options: {
    readonly encryptionFailures?: number;
    readonly writeFailures?: number;
    readonly managedConflict?: boolean;
  } = {},
) {
  const requestUrls: Array<string> = [];
  let responseIndex = 0;
  let encryptionFailures = options.encryptionFailures ?? 0;
  let writeFailures = options.writeFailures ?? 0;
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);
        const response = responses[responseIndex++];
        if (response === undefined) throw new Error(`Unexpected request: ${request.url}`);
        return jsonResponse(request, response.body, response.status);
      }),
    ),
  );
  const initialSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    primaryBackend: { mode: "managed" },
  };
  const settingsRefEffect = Ref.make(initialSettings);
  const settingsLayer = Layer.effect(
    DesktopAppSettings.DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* settingsRefEffect;
      const update = (
        preference: DesktopAppSettings.DesktopPrimaryBackendPreference,
      ): Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError> => {
        if (writeFailures > 0) {
          writeFailures -= 1;
          return Effect.fail(
            new DesktopAppSettings.DesktopSettingsWriteError({
              operation: "replace-settings-file",
              path: "/tmp/desktop-settings.json",
              cause: "settings write failed",
            }),
          );
        }
        return Ref.update(settingsRef, (settings) => ({ ...settings, primaryBackend: preference }));
      };
      return DesktopAppSettings.DesktopAppSettings.of({
        get: Ref.get(settingsRef),
        load: Ref.get(settingsRef),
        setMainWindowBounds: () => Effect.die("unexpected settings update"),
        setServerExposureMode: () => Effect.die("unexpected settings update"),
        setTailscaleServe: () => Effect.die("unexpected settings update"),
        setUpdateChannel: () => Effect.die("unexpected settings update"),
        setWslBackendEnabled: () => Effect.die("unexpected settings update"),
        setWslDistro: () => Effect.die("unexpected settings update"),
        setWslOnly: () => Effect.die("unexpected settings update"),
        setPrimaryBackendPreference: (preference) =>
          update(preference).pipe(
            Effect.map(() => ({
              settings: { ...initialSettings, primaryBackend: preference },
              changed: true,
            })),
          ),
        applyWslWindowsFallback: Effect.die("unexpected settings update"),
        applyWslWindowsFallbackInMemory: Effect.die("unexpected settings update"),
      });
    }),
  );
  const encryptedCredentials: Array<string> = [];
  const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (credential: string) =>
      Effect.gen(function* () {
        if (encryptionFailures > 0) {
          encryptionFailures -= 1;
          return yield* Effect.fail({ _tag: "TestEncryptionFailure" as const });
        }
        encryptedCredentials.push(credential);
        return new TextEncoder().encode(`encrypted:${credential}`);
      }),
    decryptString: () => Effect.succeed("stored-bearer-token"),
    selectedStorageBackend: Effect.succeed(Option.none()),
  } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]);
  const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform: "darwin",
    appVersion: "0.0.17",
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed(
      options.managedConflict
        ? [
            {
              currentConfig: Effect.succeed(
                Option.some({ httpBaseUrl: new URL(ATTACHED_HTTP_BASE_URL) }),
              ),
            },
          ]
        : [],
    ),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  const dependencies = Layer.mergeAll(
    settingsLayer,
    safeStorageLayer,
    httpClientLayer,
    environmentLayer,
    poolLayer,
  );
  const layer = Layer.merge(
    DesktopAttachedBackend.layer.pipe(Layer.provide(dependencies)),
    settingsLayer,
  );

  return { layer, encryptedCredentials, requestUrls, initialSettings };
}

describe("DesktopAttachedBackend", () => {
  it.effect("performs one initial exchange and persists only encrypted attachment state", () => {
    const harness = makeAttachHarness([{ body: administrativeToken() }, { body: descriptorFor() }]);

    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-08T12:00:00.000Z"));
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const state = yield* attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token");
      const persisted = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;

      assert.deepEqual(harness.requestUrls, [
        "http://127.0.0.1:4100/oauth/token",
        "http://127.0.0.1:4100/.well-known/t3/environment",
      ]);
      assert.equal(harness.encryptedCredentials.length, 1);
      assert.notInclude(harness.encryptedCredentials[0] ?? "", "one-time-owner-token");
      assert.equal(state.mode, "attached");
      assert.equal(persisted.primaryBackend.mode, "attached");
      if (persisted.primaryBackend.mode === "attached") {
        assert.notInclude(persisted.primaryBackend.encryptedBearerToken, "one-time-owner-token");
        assert.notInclude(
          persisted.primaryBackend.encryptedBearerToken,
          "replacement-access-token",
        );
        assert.equal(persisted.primaryBackend.bearerExpiresAt, "2026-09-08T13:00:00.000Z");
      }
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("rejects a managed endpoint conflict before exchanging the owner credential", () => {
    const harness = makeAttachHarness([], { managedConflict: true });

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const error = yield* attached
        .attach("http://127.0.0.1:4100/pair#token=one-time-owner-token")
        .pipe(Effect.flip);

      assert.instanceOf(error, DesktopAttachedBackend.DesktopAttachManagedBackendConflictError);
      assert.deepEqual(harness.requestUrls, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "completes a retained transaction after descriptor failure without re-exchanging",
    () => {
      const harness = makeAttachHarness([
        { body: administrativeToken() },
        { status: 503, body: { unavailable: true } },
        { body: descriptorFor() },
      ]);

      return Effect.gen(function* () {
        const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
        const first = yield* Effect.exit(
          attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token"),
        );
        assert.equal(first._tag, "Failure");
        const second = yield* attached.attach(
          "http://127.0.0.1:4100/pair#token=one-time-owner-token",
        );

        assert.equal(second.mode, "attached");
        assert.deepEqual(harness.requestUrls, [
          "http://127.0.0.1:4100/oauth/token",
          "http://127.0.0.1:4100/.well-known/t3/environment",
          "http://127.0.0.1:4100/.well-known/t3/environment",
        ]);
        assert.equal(harness.encryptedCredentials.length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "completes a retained transaction after encryption failure without re-exchanging",
    () => {
      const harness = makeAttachHarness(
        [{ body: administrativeToken() }, { body: descriptorFor() }, { body: descriptorFor() }],
        { encryptionFailures: 1 },
      );

      return Effect.gen(function* () {
        const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
        const first = yield* Effect.exit(
          attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token"),
        );
        assert.equal(first._tag, "Failure");
        yield* attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token");

        assert.equal(harness.requestUrls.filter((url) => url.endsWith("/oauth/token")).length, 1);
        assert.equal(harness.requestUrls.filter((url) => url.endsWith("/environment")).length, 2);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("completes a retained transaction after settings failure without re-exchanging", () => {
    const harness = makeAttachHarness(
      [{ body: administrativeToken() }, { body: descriptorFor() }, { body: descriptorFor() }],
      { writeFailures: 1 },
    );

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const first = yield* Effect.exit(
        attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token"),
      );
      assert.equal(first._tag, "Failure");
      yield* attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token");

      assert.equal(harness.requestUrls.filter((url) => url.endsWith("/oauth/token")).length, 1);
      assert.equal(harness.encryptedCredentials.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never replays an owner URL after an uncertain exchange", () => {
    const harness = makeAttachHarness([{ status: 503, body: { unavailable: true } }]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const first = yield* Effect.exit(
        attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token"),
      );
      const second = yield* Effect.exit(
        attached.attach("http://127.0.0.1:4100/pair#token=one-time-owner-token"),
      );

      assert.equal(first._tag, "Failure");
      assert.equal(second._tag, "Failure");
      if (second._tag === "Failure") {
        const error = second.cause;
        assert.include(String(error), "FreshPairingUrl");
      }
      assert.equal(harness.requestUrls.filter((url) => url.endsWith("/oauth/token")).length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
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

  it.effect("refreshes only after precheck, scope validation, and postcheck", () => {
    const harness = makeRefreshHarness([
      { body: descriptorFor() },
      { body: administrativeToken() },
      { body: descriptorFor() },
    ]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      yield* attached.refreshCredential("replacement-owner-token");

      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      const persisted = yield* settings.get;
      assert.deepEqual(harness.requestUrls, [
        "http://127.0.0.1:4100/.well-known/t3/environment",
        "http://127.0.0.1:4100/oauth/token",
        "http://127.0.0.1:4100/.well-known/t3/environment",
      ]);
      assert.deepEqual(harness.encryptedCredentials, ["replacement-access-token"]);
      assert.equal(persisted.primaryBackend.mode, "attached");
      if (persisted.primaryBackend.mode === "attached") {
        assert.notInclude(persisted.primaryBackend.encryptedBearerToken, "replacement-owner-token");
        assert.notInclude(
          persisted.primaryBackend.encryptedBearerToken,
          "replacement-access-token",
        );
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects a precheck identity mismatch before exchanging any credential", () => {
    const harness = makeRefreshHarness([{ body: descriptorFor("other-environment") }]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const error = yield* attached.refreshCredential("replacement-owner-token").pipe(Effect.flip);

      assert.instanceOf(error, DesktopAttachedBackend.DesktopAttachedIdentityMismatchError);
      assert.deepEqual(harness.requestUrls, ["http://127.0.0.1:4100/.well-known/t3/environment"]);
      assert.deepEqual(harness.encryptedCredentials, []);
      assert.deepEqual(
        yield* (yield* DesktopAppSettings.DesktopAppSettings).get,
        harness.initialSettings,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves the old attachment when credential exchange fails", () => {
    const harness = makeRefreshHarness([
      { body: descriptorFor() },
      {
        status: 401,
        body: { code: "auth_invalid", reason: "invalid_credential", traceId: "refresh-test" },
      },
    ]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const error = yield* attached.refreshCredential("replacement-owner-token").pipe(Effect.flip);

      assert.instanceOf(error, DesktopAttachedBackend.DesktopAttachCredentialExchangeError);
      assert.deepEqual(harness.encryptedCredentials, []);
      assert.deepEqual(
        yield* (yield* DesktopAppSettings.DesktopAppSettings).get,
        harness.initialSettings,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves the old attachment when the replacement lacks administrative scopes", () => {
    const harness = makeRefreshHarness([
      { body: descriptorFor() },
      { body: administrativeToken(AuthStandardClientScopes.join(" ")) },
    ]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const error = yield* attached.refreshCredential("replacement-owner-token").pipe(Effect.flip);

      assert.instanceOf(error, DesktopAttachedBackend.DesktopAttachAdministrativeScopeError);
      assert.deepEqual(harness.encryptedCredentials, []);
      assert.deepEqual(
        yield* (yield* DesktopAppSettings.DesktopAppSettings).get,
        harness.initialSettings,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not encrypt or persist after the postcheck identity changes", () => {
    const harness = makeRefreshHarness([
      { body: descriptorFor() },
      { body: administrativeToken() },
      { body: descriptorFor("other-environment") },
    ]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const error = yield* attached.refreshCredential("replacement-owner-token").pipe(Effect.flip);

      assert.instanceOf(error, DesktopAttachedBackend.DesktopAttachedIdentityMismatchError);
      assert.deepEqual(harness.encryptedCredentials, []);
      assert.deepEqual(
        yield* (yield* DesktopAppSettings.DesktopAppSettings).get,
        harness.initialSettings,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps probe identity checks ahead of the authenticated session request", () => {
    const harness = makeRefreshHarness([{ body: descriptorFor("other-environment") }]);

    return Effect.gen(function* () {
      const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
      const error = yield* attached.probe.pipe(Effect.flip);

      assert.instanceOf(error, DesktopAttachedBackend.DesktopAttachedIdentityMismatchError);
      assert.deepEqual(harness.requestUrls, ["http://127.0.0.1:4100/.well-known/t3/environment"]);
    }).pipe(Effect.provide(harness.layer));
  });
});
