import {
  catalogDirectoryRoutes,
  setLearnedRoutesInCatalog,
  putConnectionProfileInCatalog,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  removeCatalogValue,
  replaceCatalogValue,
  Persistence,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import { SelfHostedRelayAccountStore } from "@t3tools/client-runtime/self-hosted-relay";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionTransientError,
  CredentialStore,
  ProfileStore,
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CatalogStore from "./catalog-store";
import * as RelayAccountStore from "./selfHostedRelayAccountStore";
import { routeOrigin, verifiedRouteFor } from "./verified-route";

function targetPersistenceError(
  operation:
    | "list-targets"
    | "list-disabled-targets"
    | "list-directory-routes"
    | "register-connection"
    | "set-connection-routes"
    | "remove-connection"
    | "set-connection-enabled",
  error: ConnectionTransientError,
) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();
    const relayAccount = yield* RelayAccountStore.make();
    const githubRoutingPermissions = yield* makePullRequestRoutingPermissions({
      read: catalog.read.pipe(Effect.map((document) => document.githubRoutingPermissions ?? [])),
      write: (githubRoutingPermissions) =>
        catalog.update((document) => ({ ...document, githubRoutingPermissions })),
    });

    const targetStore = Persistence.ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((error) => targetPersistenceError("list-disabled-targets", error)),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: Effect.fn("Persistence.ConnectionRegistrationStore.register")(
        (registration, routes, removedRouteIds) => {
          const classified =
            registration._tag === "BearerConnectionRegistration" &&
            registration.profile.verificationRequired === undefined
              ? new BearerConnectionRegistration({
                  ...registration,
                  profile: new BearerConnectionProfile({
                    ...registration.profile,
                    verificationRequired: false,
                  }),
                })
              : registration;
          return catalog
            .update((document) =>
              registerConnectionInCatalog(document, classified, routes, removedRouteIds),
            )
            .pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error)));
        },
      ),
      setRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.setRoutes")(
        (environmentId, routes, removedRouteIds) =>
          catalog
            .update((document) =>
              setRoutesInCatalog(document, environmentId, routes, removedRouteIds),
            )
            .pipe(
              Effect.mapError((error) => targetPersistenceError("set-connection-routes", error)),
            ),
      ),
      listDirectoryRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.listDirectoryRoutes")(
        (source) =>
          catalog.readFresh.pipe(
            Effect.map((document) => catalogDirectoryRoutes(document, source)),
            Effect.mapError((error) => targetPersistenceError("list-directory-routes", error)),
          ),
      ),
      setLearnedRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.setLearnedRoutes")(
        (environmentId, routes, changes) =>
          catalog
            .update((document) =>
              setLearnedRoutesInCatalog(document, environmentId, routes, changes),
            )
            .pipe(
              Effect.mapError((error) => targetPersistenceError("set-connection-routes", error)),
            ),
      ),
      remove: Effect.fn("Persistence.ConnectionRegistrationStore.remove")((environmentId) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, environmentId))
          .pipe(Effect.mapError((error) => targetPersistenceError("remove-connection", error))),
      ),
      setEnabled: Effect.fn("Persistence.ConnectionRegistrationStore.setEnabled")(
        (environmentId, enabled) =>
          catalog
            .update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled))
            .pipe(
              Effect.mapError((error) => targetPersistenceError("set-connection-enabled", error)),
            ),
      ),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) => {
            const profile = document.profiles.find(
              (candidate) => candidate.connectionId === connectionId,
            );
            if (profile?._tag !== "BearerConnectionProfile") {
              return Option.fromUndefinedOr(profile);
            }
            // An old TLS profile can outlive its separate enrollment record.
            if (
              !profile.learned &&
              profile.verificationRequired === undefined &&
              !(profile.httpBaseUrl.startsWith("http://") && profile.wsBaseUrl.startsWith("ws://"))
            ) {
              return Option.none();
            }
            const binding = verifiedRouteFor(profile.httpBaseUrl);
            return binding !== undefined &&
              (binding.environmentId !== profile.environmentId ||
                !profile.wsBaseUrl.startsWith("wss:") ||
                routeOrigin(profile.wsBaseUrl) !== binding.httpsOrigin)
              ? Option.none()
              : Option.some(profile);
          }),
        ),
      put: (profile) =>
        catalog.update((document) => putConnectionProfileInCatalog(document, profile)),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
            ),
          ),
        ),
      put: (token) => catalog.update((document) => putRemoteDpopTokenInCatalog(document, token)),
      remove: (environmentId) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, githubRoutingPermissions),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(SelfHostedRelayAccountStore, relayAccount),
    );
  }),
);
