import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionProfile,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import { migrateLegacyConnectionCatalog } from "./migration";
import {
  markVerificationRequired,
  refreshVerifiedRoutes,
  routeOrigin,
  verifiedRouteFor,
} from "./verified-route";

export const CONNECTION_CATALOG_KEY = "t3code.connection-catalog.v1";
export const LEGACY_CONNECTIONS_KEY = "t3code.connections";

// Connection runtimes in this process write the same SecureStore key.
const catalogLock = Semaphore.makeUnsafe(1);
let catalogRevision = 0;

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);

const decodeCatalog = Effect.fn("mobile.connectionStorage.decodeCatalog")(function* (raw: string) {
  return yield* decodeConnectionCatalogDocument(raw).pipe(
    Effect.mapError((cause) => catalogError("decode", cause)),
  );
});

const encodeCatalog = Effect.fn("mobile.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly readFresh: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export const make = Effect.fn("mobile.connectionStorage.makeCatalogStore")(function* () {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const getItem = (key: string) =>
    storage.getItem(key).pipe(Effect.mapError((cause) => catalogError("load", cause)));
  const setItem = (key: string, value: string) =>
    storage.setItem(key, value).pipe(Effect.mapError((cause) => catalogError("save", cause)));
  const deleteItem = (key: string) =>
    storage.removeItem(key).pipe(Effect.mapError((cause) => catalogError("delete", cause)));
  let cached: { raw: string; catalog: ConnectionCatalogDocumentType; revision: number } | undefined;

  const saveUnlocked = Effect.fn("mobile.connectionStorage.saveCatalog")(function* (
    catalog: ConnectionCatalogDocumentType,
  ) {
    const raw = yield* encodeCatalog(catalog);
    yield* setItem(CONNECTION_CATALOG_KEY, raw);
    catalogRevision++;
    return raw;
  }, Effect.uninterruptible);

  const loadLegacyCatalog = Effect.fn("mobile.connectionStorage.loadLegacyCatalog")(function* () {
    const legacyRaw = yield* getItem(LEGACY_CONNECTIONS_KEY);
    const catalog =
      legacyRaw === null || legacyRaw.trim() === ""
        ? EMPTY_CONNECTION_CATALOG_DOCUMENT
        : yield* migrateLegacyConnectionCatalog(legacyRaw).pipe(
            Effect.mapError((cause) => catalogError("migrate", cause)),
            Effect.catch((error) =>
              Effect.logWarning("Discarding corrupt legacy mobile connections", error).pipe(
                Effect.as(EMPTY_CONNECTION_CATALOG_DOCUMENT),
              ),
            ),
          );
    let raw = "";
    if (legacyRaw !== null && legacyRaw.trim() !== "") {
      raw = yield* saveUnlocked(catalog);
      yield* deleteItem(LEGACY_CONNECTIONS_KEY);
    }
    return { raw, catalog };
  });

  const loadUnlocked = Effect.fn("mobile.connectionStorage.loadCatalog")(function* () {
    const raw = (yield* getItem(CONNECTION_CATALOG_KEY)) ?? "";
    if (raw !== "" && cached?.raw === raw) {
      cached.revision = catalogRevision;
      return cached.catalog;
    }
    let loaded =
      raw.trim() === ""
        ? yield* loadLegacyCatalog()
        : yield* decodeCatalog(raw).pipe(
            Effect.map((catalog) => ({ raw, catalog })),
            Effect.catch((error) =>
              Effect.logWarning("Discarding corrupt mobile connection catalog", error).pipe(
                Effect.andThen(
                  deleteItem(CONNECTION_CATALOG_KEY).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        catalogRevision++;
                      }),
                    ),
                    Effect.uninterruptible,
                  ),
                ),
                Effect.andThen(loadLegacyCatalog()),
              ),
            ),
          );
    const { catalog } = loaded;
    if (catalog.profiles.some((profile) => profile._tag === "BearerConnectionProfile")) {
      yield* Effect.tryPromise({
        try: refreshVerifiedRoutes,
        catch: (cause) => catalogError("classify route verification for", cause),
      }).pipe(
        Effect.catch((error) =>
          catalog.profiles.some(
            (profile) =>
              profile._tag === "BearerConnectionProfile" &&
              !profile.learned &&
              profile.verificationRequired === undefined,
          )
            ? Effect.fail(error)
            : Effect.void,
        ),
      );
      const profiles = catalog.profiles.map((profile) => {
        if (profile._tag !== "BearerConnectionProfile" || profile.learned) return profile;
        const binding = verifiedRouteFor(profile.httpBaseUrl);
        if (profile.verificationRequired) {
          markVerificationRequired(profile.httpBaseUrl);
          return profile;
        }
        if (
          binding !== undefined &&
          binding.environmentId === profile.environmentId &&
          profile.wsBaseUrl.startsWith("wss:") &&
          routeOrigin(profile.wsBaseUrl) === binding.httpsOrigin
        ) {
          return new BearerConnectionProfile({ ...profile, verificationRequired: true });
        }
        return profile;
      });
      if (profiles.some((profile, index) => profile !== catalog.profiles[index])) {
        const classified = { ...catalog, profiles };
        loaded = { raw: yield* saveUnlocked(classified), catalog: classified };
      }
    }
    cached = { ...loaded, revision: catalogRevision };
    return loaded.catalog;
  });

  const readFresh = catalogLock.withPermit(loadUnlocked());
  const read = Effect.suspend(() =>
    cached?.revision === catalogRevision ? Effect.succeed(cached.catalog) : readFresh,
  );
  const update: CatalogStore["update"] = Effect.fn("mobile.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* catalogLock.withPermit(
        Effect.gen(function* () {
          const catalog = transform(yield* loadUnlocked());
          cached = { raw: yield* saveUnlocked(catalog), catalog, revision: catalogRevision };
        }),
      );
    },
  );

  return { read, readFresh, update } satisfies CatalogStore;
});
