import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BearerConnectionProfile,
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import { type ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import { borrowedCredentialRouteId, connectionRouteId } from "../connection/routes.ts";
import type { LearnedRouteChanges, StoredDirectoryRoute } from "./persistence.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Records owned by a dropped route go with it; the environment keeps its
 * position in the catalog. An empty list leaves the environment's other records
 * in place; use `removeConnectionFromCatalog` to forget the environment.
 */
function replaceCatalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(connectionRouteId));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(connectionRouteId(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
  removedRouteIds: ReadonlySet<string> = new Set(),
): ConnectionCatalogDocument {
  const ordered = new Set(routes.map(connectionRouteId));
  const stored = catalogRoutes(document, environmentId);
  const profiles = new Map(
    document.profiles
      .filter((profile) => profile.environmentId === environmentId)
      .map((profile) => [profile.connectionId, profile]),
  );
  const learned = (id: string) => {
    const profile = profiles.get(id);
    return (
      id.startsWith("learned:") ||
      (profile?._tag === "BearerConnectionProfile" && profile.learned === true)
    );
  };
  const removed = new Set(removedRouteIds);
  for (const target of stored) {
    const id = connectionRouteId(target);
    if (!ordered.has(id) && !learned(id)) removed.add(id);
  }
  const isRemoved = (id: string) => {
    const donor = borrowedCredentialRouteId(id, profiles.get(id));
    return removed.has(id) || (learned(id) && donor !== undefined && removed.has(donor));
  };
  const hidden = stored.filter((target) => {
    const id = connectionRouteId(target);
    return !ordered.has(id) && !isRemoved(id);
  });
  const next = replaceCatalogRoutes(document, environmentId, [...routes, ...hidden]);
  return {
    ...next,
    profiles: next.profiles.filter(
      (profile) => profile.environmentId !== environmentId || !isRemoved(profile.connectionId),
    ),
  };
}

export function catalogDirectoryRoutes(
  document: ConnectionCatalogDocument,
  source: string,
): ReadonlyArray<StoredDirectoryRoute> {
  return document.profiles.flatMap((profile) =>
    profile._tag === "BearerConnectionProfile" &&
    profile.learned &&
    profile.directorySource === source
      ? [{ environmentId: profile.environmentId, connectionId: profile.connectionId }]
      : [],
  );
}

export function putConnectionProfileInCatalog(
  document: ConnectionCatalogDocument,
  profile: ConnectionProfile,
): ConnectionCatalogDocument {
  const previous = document.profiles.find((value) => value.connectionId === profile.connectionId);
  // Discovery can update metadata after storage has classified a profile's verification policy.
  const next =
    profile._tag === "BearerConnectionProfile" &&
    profile.verificationRequired === undefined &&
    previous?._tag === "BearerConnectionProfile" &&
    previous.verificationRequired !== undefined &&
    previous.environmentId === profile.environmentId &&
    previous.httpBaseUrl === profile.httpBaseUrl &&
    previous.wsBaseUrl === profile.wsBaseUrl
      ? new BearerConnectionProfile({
          ...profile,
          verificationRequired: previous.verificationRequired,
        })
      : profile;
  return {
    ...document,
    profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, next),
  };
}

export function setLearnedRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  addedTargets: ReadonlyArray<PersistedConnectionTarget>,
  { profiles, removedConnectionIds, routeOrder }: LearnedRouteChanges,
): ConnectionCatalogDocument {
  const routes = catalogRoutes(document, environmentId).filter(
    (target) => !removedConnectionIds.has(connectionRouteId(target)),
  );
  const kept = new Set(routes.map(connectionRouteId));
  const profileIds = new Set(profiles.map((profile) => profile.connectionId));
  const positions = new Map(routeOrder?.map((id, index) => [id, index]));
  for (const target of addedTargets) {
    const id = connectionRouteId(target);
    // An order from another runtime can still name a withdrawn directory route.
    if (kept.has(id) || !profileIds.has(id) || removedConnectionIds.has(id)) continue;
    const position = positions.get(id) ?? Infinity;
    const insertAt = routes.findIndex(
      (route) => (positions.get(connectionRouteId(route)) ?? -1) > position,
    );
    routes.splice(insertAt === -1 ? routes.length : insertAt, 0, target);
    kept.add(id);
  }
  const next = replaceCatalogRoutes(document, environmentId, routes);
  return profiles
    .filter((profile) => kept.has(profile.connectionId))
    .reduce(putConnectionProfileInCatalog, {
      ...next,
      // Older writes could leave a staged profile without a corresponding target.
      profiles: next.profiles.filter(
        (profile) =>
          profile.environmentId !== environmentId ||
          !removedConnectionIds.has(profile.connectionId),
      ),
    });
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
  removedRouteIds?: ReadonlySet<string>,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(
    document,
    registration.target.environmentId,
    routes,
    removedRouteIds,
  );

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
  }
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = replaceCatalogRoutes(document, environmentId, []);
  return {
    ...next,
    profiles: next.profiles.filter(
      (profile) =>
        profile.environmentId !== environmentId ||
        profile._tag !== "BearerConnectionProfile" ||
        !profile.learned,
    ),
    remoteDpopTokens: removeCatalogValue(
      next.remoteDpopTokens,
      (value) => value.environmentId,
      environmentId,
    ),
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}

export function putRemoteDpopTokenInCatalog(
  document: ConnectionCatalogDocument,
  token: TokenStore.RemoteDpopAccessToken,
): ConnectionCatalogDocument {
  const registered = document.targets.some(
    (target) =>
      target._tag === "RelayConnectionTarget" && target.environmentId === token.environmentId,
  );
  if (!registered) {
    return document;
  }
  return {
    ...document,
    remoteDpopTokens: replaceCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      token,
    ),
  };
}
