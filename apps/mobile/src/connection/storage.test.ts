import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { getItemAsync } from "expo-secure-store";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import { SelfHostedRelayAccountStore } from "@t3tools/client-runtime/self-hosted-relay";

import * as SecureRandom from "effect/crypto/SecureRandom";

vi.mock("expo-crypto", () => ({ randomUUID: () => SecureRandom.uuidV4Unsafe() }));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import * as ConnectionStorage from "./storage";
import { readVerifiedRouteEnrollment, verificationRequiredFor } from "./verified-route";

const decodeBearerRegistration = Schema.decodeUnknownSync(BearerConnectionRegistration);

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("persists the requirement with the bearer when upgrading an enrolled catalog", () =>
    Effect.gen(function* () {
      const httpsOrigin = "https://enrolled.example.test";
      const enrollment = {
        environmentId: "saved-environment",
        httpsOrigin,
        leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      };
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: "verified",
              environmentId: enrollment.environmentId,
              label: "Verified",
              httpBaseUrl: httpsOrigin,
              wsBaseUrl: "wss://enrolled.example.test",
            },
            {
              _tag: "BearerConnectionProfile",
              connectionId: "ordinary",
              environmentId: enrollment.environmentId,
              label: "Ordinary",
              httpBaseUrl: "http://192.168.1.2:3773",
              wsBaseUrl: "ws://192.168.1.2:3773",
            },
          ],
          credentials: [
            {
              connectionId: "verified",
              credential: { _tag: "BearerConnectionCredential", token: "saved-bearer" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      });
      const openCatalog = make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      const catalog = yield* openCatalog;
      vi.mocked(getItemAsync).mockRejectedValueOnce(new Error("SecureStore unavailable"));
      expect((yield* Effect.exit(catalog.read))._tag).toBe("Failure");
      expect(
        JSON.parse(memory.values.get(CONNECTION_CATALOG_KEY) ?? "{}").profiles[0],
      ).not.toHaveProperty("verificationRequired");
      vi.mocked(getItemAsync).mockResolvedValueOnce(JSON.stringify([enrollment]));
      const migrated = yield* catalog.read;
      expect(migrated.profiles[0]).toHaveProperty("verificationRequired", true);
      expect(migrated.profiles[1]).not.toHaveProperty("verificationRequired");
      expect(migrated.credentials[0]?.credential.token).toBe("saved-bearer");

      expect(JSON.parse(memory.values.get(CONNECTION_CATALOG_KEY) ?? "{}")).toMatchObject({
        profiles: [{ verificationRequired: true }, { connectionId: "ordinary" }],
        credentials: [{ connectionId: "verified", credential: { token: "saved-bearer" } }],
      });
    }),
  );

  it.effect.each([
    { state: "missing", raw: null },
    { state: "corrupt", raw: "{corrupt" },
  ])("keeps cached HTTP and WSS marked when the pin is $state", ({ state, raw }) =>
    Effect.gen(function* () {
      const host = `${state}.example.test`;
      const httpsOrigin = `https://${host}`;
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: "verified",
              environmentId: "saved-environment",
              label: "Verified",
              httpBaseUrl: httpsOrigin,
              wsBaseUrl: `wss://${host}`,
              verificationRequired: true,
            },
          ],
          credentials: [
            {
              connectionId: "verified",
              credential: { _tag: "BearerConnectionCredential", token: "saved-bearer" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      });
      expect(verificationRequiredFor(httpsOrigin)).toBe(false);
      vi.mocked(getItemAsync).mockResolvedValueOnce(raw);
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      expect((yield* catalog.read).profiles[0]).toHaveProperty("verificationRequired", true);
      vi.mocked(getItemAsync).mockResolvedValueOnce(raw);
      expect(yield* Effect.promise(() => readVerifiedRouteEnrollment(httpsOrigin))).toBeNull();
      expect(verificationRequiredFor(`${httpsOrigin}/api/assets/signed/report.pdf`)).toBe(true);
      expect(verificationRequiredFor(`wss://${host}/ws`)).toBe(true);
      expect(verificationRequiredFor("http://192.168.1.2:3773")).toBe(false);
    }),
  );

  it.effect("requires reapproval of an unclassified HTTPS profile with no pin record", () =>
    Effect.gen(function* () {
      const profile = {
        _tag: "BearerConnectionProfile",
        connectionId: "old-https",
        environmentId: "saved-environment",
        label: "Saved",
        httpBaseUrl: "https://old.example.test",
        wsBaseUrl: "wss://old.example.test",
      };
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [],
          profiles: [
            profile,
            {
              ...profile,
              connectionId: "old-http",
              httpBaseUrl: "http://192.168.1.2:3773",
              wsBaseUrl: "ws://192.168.1.2:3773",
            },
          ],
          credentials: [
            {
              connectionId: "old-https",
              credential: { _tag: "BearerConnectionCredential", token: "saved-bearer" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      });
      const storage = ConnectionStorage.layer.pipe(
        Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, memory.storage)),
      );
      vi.mocked(getItemAsync).mockResolvedValueOnce(null);
      yield* Effect.gen(function* () {
        const profiles = yield* ProfileStore.ConnectionProfileStore;
        const registrations = yield* Persistence.ConnectionRegistrationStore;
        expect(yield* profiles.get(profile.connectionId)).toEqual(Option.none());
        expect(Option.isSome(yield* profiles.get("old-http"))).toBe(true);

        const approved = decodeBearerRegistration({
          _tag: "BearerConnectionRegistration",
          target: {
            _tag: "BearerConnectionTarget",
            connectionId: profile.connectionId,
            environmentId: profile.environmentId,
            label: profile.label,
          },
          profile,
          credential: { _tag: "BearerConnectionCredential", token: "fresh-bearer" },
        });
        yield* registrations.register(approved, [approved.target]);
        yield* profiles.put(
          new BearerConnectionProfile({ ...approved.profile, network: "tailscale" }),
        );
      }).pipe(Effect.provide(storage));

      vi.mocked(getItemAsync).mockResolvedValueOnce(null);
      yield* Effect.gen(function* () {
        const profiles = yield* ProfileStore.ConnectionProfileStore;
        expect(Option.getOrNull(yield* profiles.get(profile.connectionId))).toMatchObject({
          verificationRequired: false,
          network: "tailscale",
        });
      }).pipe(Effect.provide(storage));
    }),
  );

  it.effect("lists directory provenance when a mismatched binding hides the runtime profile", () =>
    Effect.gen(function* () {
      const httpsOrigin = "https://directory-binding.example.test";
      const profile = {
        _tag: "BearerConnectionProfile",
        connectionId: "learned:directory-binding",
        environmentId: "saved-environment",
        label: "Saved",
        httpBaseUrl: httpsOrigin,
        wsBaseUrl: "wss://directory-binding.example.test",
        verificationRequired: true,
        learned: true,
        directorySource: "saved-directory",
      };
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              connectionId: profile.connectionId,
              environmentId: profile.environmentId,
              label: profile.label,
            },
          ],
          profiles: [profile],
          credentials: [],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      });
      vi.mocked(getItemAsync).mockResolvedValueOnce(
        JSON.stringify([
          {
            environmentId: "different-environment",
            httpsOrigin,
            leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        ]),
      );
      const storage = ConnectionStorage.layer.pipe(
        Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, memory.storage)),
      );
      yield* Effect.gen(function* () {
        const profiles = yield* ProfileStore.ConnectionProfileStore;
        const registrations = yield* Persistence.ConnectionRegistrationStore;
        expect(yield* profiles.get(profile.connectionId)).toEqual(Option.none());
        expect(yield* registrations.listDirectoryRoutes(profile.directorySource)).toEqual([
          { environmentId: profile.environmentId, connectionId: profile.connectionId },
        ]);
      }).pipe(Effect.provide(storage));
    }),
  );

  it.effect(
    "withdraws routes published after another mobile storage runtime cached the catalog",
    () =>
      Effect.gen(function* () {
        const memory = makeStorage({});
        const open = () =>
          Layer.build(Layer.fresh(ConnectionStorage.layer)).pipe(
            Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
          );
        const first = yield* open();
        const second = yield* open();
        const writer = Context.get(first, Persistence.ConnectionRegistrationStore);
        const clearer = Context.get(second, Persistence.ConnectionRegistrationStore);
        const account = Context.get(second, SelfHostedRelayAccountStore);
        const relayId = SelfHostedRelayId.make("shared-mobile-relay");
        const source = JSON.stringify([relayId, "self-hosted-relay-account"]);
        const environmentId = EnvironmentId.make("shared-mobile-environment");
        const target = new BearerConnectionTarget({
          environmentId,
          connectionId: "learned:shared-mobile-directory",
          label: "Directory route",
        });
        const profile = new BearerConnectionProfile({
          environmentId,
          connectionId: target.connectionId,
          label: target.label,
          httpBaseUrl: "https://shared-mobile-directory.example.test",
          wsBaseUrl: "wss://shared-mobile-directory.example.test",
          learned: true,
          directorySource: source,
        });
        expect(yield* Context.get(second, Persistence.ConnectionTargetStore).list).toEqual([]);
        yield* writer.setLearnedRoutes(environmentId, [target], {
          profiles: [profile],
          removedConnectionIds: new Set(),
        });
        yield* account.exclusive(
          Effect.gen(function* () {
            const tombstone = {
              version: 2,
              revision: yield* account.newRevision,
              account: null,
              withdrawal: relayId,
            } as const;
            yield* account.write(tombstone);
            for (const route of yield* clearer.listDirectoryRoutes(source)) {
              yield* clearer.setLearnedRoutes(route.environmentId, [], {
                profiles: [],
                removedConnectionIds: new Set([route.connectionId]),
              });
            }
            yield* account.write({ ...tombstone, withdrawal: null });
          }),
        );
        expect(yield* account.read).toMatchObject({ account: null, withdrawal: null });
        const reopened = yield* open();
        expect(
          yield* Context.get(reopened, Persistence.ConnectionRegistrationStore).listDirectoryRoutes(
            source,
          ),
        ).toEqual([]);
        expect(yield* Context.get(reopened, Persistence.ConnectionTargetStore).list).toEqual([]);
      }),
  );

  it.effect("serializes concurrent catalog updates across mobile runtimes", () =>
    Effect.gen(function* () {
      const memory = makeStorage({});
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, {
          ...memory.storage,
          setItem: (key, value) =>
            Deferred.succeed(writing, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(memory.storage.setItem(key, value)),
            ),
        }),
      );
      const open = make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      const other = yield* open;
      yield* writer.read;
      yield* other.read;
      const disable = (id: string) => (document: Effect.Success<typeof writer.read>) => ({
        ...document,
        disabledEnvironmentIds: [...document.disabledEnvironmentIds, EnvironmentId.make(id)],
      });
      const first = yield* writer
        .update(disable("first"))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(writing);
      const second = yield* other
        .update(disable("second"))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      const reopened = yield* open;
      expect((yield* reopened.read).disabledEnvironmentIds).toEqual(["first", "second"]);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
