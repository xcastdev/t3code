import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveDesktopAttachPairingTarget } from "./DesktopAttachedBackend.ts";

describe("DesktopAttachedBackend pairing target", () => {
  it.effect("accepts a loopback owner link and strips the credential from endpoints", () =>
    Effect.gen(function* () {
      const target = yield* resolveDesktopAttachPairingTarget(
        "http://127.0.0.1:4773/pair#token=owner-credential",
      );
      assert.equal(target.httpBaseUrl, "http://127.0.0.1:4773/");
      assert.equal(target.wsBaseUrl, "ws://127.0.0.1:4773/");
      assert.equal(target.credential, "owner-credential");
    }),
  );

  it.effect("rejects remote URLs, userinfo, and unknown parameters", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://example.test:4773/pair#token=owner",
        "http://user:pass@127.0.0.1:4773/pair#token=owner",
        "http://127.0.0.1:4773/pair?unexpected=true#token=owner",
      ]) {
        const exit = yield* Effect.exit(resolveDesktopAttachPairingTarget(url));
        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          assert.isTrue(exit.cause.toString().includes("DesktopAttachPairingUrlError"));
        }
      }
    }),
  );
});

import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Base64 from "effect/encoding/Base64";
import * as Auth from "./DesktopLocalEnvironmentAuth.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as Attached from "./DesktopAttachedBackend.ts";

const fixture = Effect.gen(function* () {
  const blocked = yield* Ref.make(false);
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const authorizations = yield* Ref.make<Array<{ port: string; bearer: string | undefined }>>([]);
  const identity = yield* Ref.make("attached-environment");
  const encrypted = yield* Ref.make<string[]>([]);
  const requests = yield* Ref.make<string[]>([]);
  const encryptionAvailable = yield* Ref.make(true);
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/tmp/attached-test",
    platform: "darwin",
    processArch: "x64",
    appVersion: "0.0.17",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: "/tmp/attached-test" }),
      ),
    ),
  );
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const port = new URL(request.url).port;
      const path = new URL(request.url).pathname;
      if (port === "4773" && path === "/.well-known/t3/environment" && (yield* Ref.get(blocked))) {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }
      if (path === "/api/auth/session")
        yield* Ref.update(authorizations, (items) => [
          ...items,
          { port, bearer: request.headers.authorization },
        ]);
      yield* Ref.update(requests, (items) => [...items, path]);
      const body =
        path === "/oauth/token"
          ? {
              access_token: `fake-bearer-${port}`,
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: AuthStandardClientScopes.join(" "),
            }
          : path === "/.well-known/t3/environment"
            ? {
                environmentId: yield* Ref.get(identity),
                label: "Independent server",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.17",
                capabilities: { repositoryIdentity: false },
              }
            : {
                authenticated: true,
                scopes: AuthStandardClientScopes,
                permissions: AuthStandardClientScopes,
                auth: {
                  policy: "remote-reachable",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["bearer-access-token"],
                  sessionCookieName: "test",
                },
              };
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
    }),
  );
  const settingsLayer = DesktopAppSettings.layerTest();
  const pool = DesktopBackendPool.DesktopBackendPool.of({
    list: Effect.succeed([]),
    get: () => Effect.succeedNone,
    primary: Effect.die("No managed primary in attached fixture"),
    register: () => Effect.die("Must never acquire an attached process"),
    unregister: () => Effect.die("Must never terminate an attached process"),
  });
  const storage = ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Ref.get(encryptionAvailable),
    selectedStorageBackend: Effect.succeedNone,
    encryptString: (value) =>
      Ref.update(encrypted, (items) => [...items, value]).pipe(
        Effect.as(new TextEncoder().encode(`cipher:${value}`)),
      ),
    decryptString: (value) => Effect.succeed(new TextDecoder().decode(value).slice(7)),
  });
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    settingsLayer,
    environment,
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, storage),
    Layer.succeed(DesktopBackendPool.DesktopBackendPool, pool),
  );
  const layer = Attached.layer.pipe(Layer.provideMerge(dependencies));
  return {
    identity,
    encrypted,
    requests,
    encryptionAvailable,
    layer,
    blocked,
    entered,
    release,
    authorizations,
  };
});

describe("DesktopAttachedBackend ownership and credentials", () => {
  it.effect(
    "encrypts credentials, reconnects with the same identity, and detaches without managing processes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const attached = yield* Attached.DesktopAttachedBackend;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          const state = yield* attached.attach("http://127.0.0.1:4773/pair#token=fake-owner");
          assert.equal(state.mode, "attached");
          assert.notInclude(JSON.stringify(state), "fake-bearer");
          assert.notInclude(JSON.stringify(yield* settings.get), "fake-bearer");
          assert.deepEqual(yield* Ref.get(f.encrypted), ["fake-bearer-4773"]);
          assert.equal((yield* attached.probe).environmentId, "attached-environment");
          yield* attached.refreshCredential("renewed-owner");
          assert.equal((yield* attached.probe).environmentId, "attached-environment");
          yield* settings.setLocalEnvironmentEnabled(false);
          assert.equal((yield* attached.getState).mode, "attached");
          yield* attached.useManagedBackend;
          assert.deepEqual(yield* attached.getState, { mode: "managed" });
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "rejects a replacement server before sending the saved bearer or refreshing credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const attached = yield* Attached.DesktopAttachedBackend;
          yield* attached.attach("http://127.0.0.1:4773/pair#token=fake-owner");
          yield* Ref.set(f.identity, "replacement-environment");
          yield* Ref.set(f.requests, []);
          assert.equal(
            (yield* Effect.flip(attached.probe))._tag,
            "DesktopAttachedIdentityMismatchError",
          );
          assert.equal(
            (yield* Effect.flip(attached.refreshCredential("replacement-owner")))._tag,
            "DesktopAttachedIdentityMismatchError",
          );
          assert.deepEqual(yield* Ref.get(f.requests), [
            "/.well-known/t3/environment",
            "/.well-known/t3/environment",
          ]);
          assert.equal((yield* attached.getState).mode, "attached");
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect("refuses unencrypted persistence and leaves managed preference recoverable", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.set(f.encryptionAvailable, false);
      yield* Effect.gen(function* () {
        const attached = yield* Attached.DesktopAttachedBackend;
        const error = yield* Effect.flip(
          attached.attach("http://127.0.0.1:4773/pair#token=fake-owner"),
        );
        assert.equal(error._tag, "DesktopAttachEncryptionUnavailableError");
        assert.deepEqual(yield* attached.getState, { mode: "managed" });
      }).pipe(Effect.provide(f.layer));
    }),
  );
});

describe("attachment authentication transactions", () => {
  it.effect(
    "keeps a paused probe credential bound to its endpoint while another attach queues",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const attached = yield* Attached.DesktopAttachedBackend;
          yield* attached.attach("http://127.0.0.1:4773/pair#token=owner-A");
          yield* Ref.set(f.blocked, true);
          const probe = yield* Effect.forkChild(attached.probe);
          yield* Deferred.await(f.entered);
          const attempting = yield* Deferred.make<void>();
          const attach = yield* Effect.forkChild(
            Deferred.succeed(attempting, undefined).pipe(
              Effect.andThen(attached.attach("http://127.0.0.1:4774/pair#token=owner-B")),
            ),
          );
          yield* Deferred.await(attempting);
          yield* Deferred.succeed(f.release, undefined);
          yield* Fiber.join(probe);
          yield* Fiber.join(attach);
          assert.deepEqual(yield* Ref.get(f.authorizations), [
            { port: "4773", bearer: "Bearer fake-bearer-4773" },
          ]);
          assert.equal((yield* attached.getState).mode, "attached");
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "rejects stale bootstrap revisions after refresh, reattach, and detach without issuing a session request",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const attached = yield* Attached.DesktopAttachedBackend;
          const state = yield* attached.attach("http://127.0.0.1:4773/pair#token=owner-A");
          if (state.mode !== "attached") return yield* Effect.die("Expected attachment");
          const target = {
            httpBaseUrl: state.httpBaseUrl,
            wsBaseUrl: "ws://127.0.0.1:4773/",
            environmentId: state.environmentId,
            attachmentRevision: state.attachmentRevision,
          };
          assert.equal(yield* attached.authenticate(target), "fake-bearer-4773");
          yield* attached.refreshCredential("renewed-owner");
          yield* Ref.set(f.authorizations, []);
          assert.equal(
            (yield* Effect.flip(attached.authenticate(target)))._tag,
            "DesktopAttachedIdentityMismatchError",
          );
          yield* attached.attach("http://127.0.0.1:4774/pair#token=owner-B");
          assert.equal(
            (yield* Effect.flip(attached.authenticate(target)))._tag,
            "DesktopAttachedIdentityMismatchError",
          );
          yield* attached.useManagedBackend;
          assert.equal(
            (yield* Effect.flip(attached.authenticate(target)))._tag,
            "DesktopAttachedCredentialUnavailableError",
          );
          assert.deepEqual(yield* Ref.get(f.authorizations), []);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "auth bridge rejects unqualified attached requests and returns the validated revision's bearer",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const attached = yield* Attached.DesktopAttachedBackend;
          const state = yield* attached.attach("http://127.0.0.1:4773/pair#token=owner-A");
          if (state.mode !== "attached") return yield* Effect.die("Expected attachment");
          const auth = yield* Auth.make;
          assert.equal(
            (yield* Effect.flip(auth.getBearerToken))._tag,
            "DesktopLocalEnvironmentAuthSessionBootstrapError",
          );
          const target = {
            httpBaseUrl: state.httpBaseUrl,
            wsBaseUrl: "ws://127.0.0.1:4773/",
            environmentId: state.environmentId,
            attachmentRevision: state.attachmentRevision,
          };
          yield* Ref.set(f.blocked, true);
          const authenticated = yield* Effect.forkChild(auth.getBearerTokenForTarget(target));
          yield* Deferred.await(f.entered);
          const changed = yield* Effect.forkChild(
            attached.attach("http://127.0.0.1:4774/pair#token=owner-B"),
          );
          yield* Deferred.succeed(f.release, undefined);
          assert.equal(yield* Fiber.join(authenticated), "fake-bearer-4773");
          yield* Fiber.join(changed);
          assert.equal(
            (yield* Effect.flip(auth.getBearerTokenForTarget(target)))._tag,
            "DesktopLocalEnvironmentAuthSessionBootstrapError",
          );
        }).pipe(Effect.provide(f.layer));
      }),
  );
});

it.effect(
  "decrypts the same captured preference even if persistence changes while its descriptor is paused",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const attached = yield* Attached.DesktopAttachedBackend;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* attached.attach("http://127.0.0.1:4773/pair#token=owner-A");
        const original = (yield* settings.get).primaryBackend;
        if (original?.mode !== "attached" || settings.setPrimaryBackendPreference === undefined)
          return yield* Effect.die("Expected persisted attachment");
        yield* Ref.set(f.blocked, true);
        const probe = yield* Effect.forkChild(attached.probe);
        yield* Deferred.await(f.entered);
        yield* settings.setPrimaryBackendPreference({
          ...original,
          httpBaseUrl: "http://127.0.0.1:4774/",
          wsBaseUrl: "ws://127.0.0.1:4774/",
          attachmentRevision: "different-revision",
          encryptedBearerToken: Base64.encode(new TextEncoder().encode("cipher:fake-bearer-4774")),
        });
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(probe);
        assert.deepEqual(yield* Ref.get(f.authorizations), [
          { port: "4773", bearer: "Bearer fake-bearer-4773" },
        ]);
      }).pipe(Effect.provide(f.layer));
    }),
);
