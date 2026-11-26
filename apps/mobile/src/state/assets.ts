import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
  makeRevisionedAssetUrlFamily,
} from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetCreateUrlResult, AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";

import { issuedMobileAssetUrl } from "../lib/verifiedAssetUrl";
import { useVerifiedLocalAsset } from "../lib/useVerifiedLocalAsset";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { appAtomRegistry } from "./atom-registry";
import { environmentProjectCloneListAtom } from "./projectClones";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconDatabaseCache,
  createUrl: (input) =>
    Atom.make((get) => {
      const result = get(assetEnvironment.createUrl(input));
      if (
        result._tag === "Success" &&
        issuedMobileAssetUrl(input.environmentId, result.value) === null
      ) {
        return AsyncResult.initial();
      }
      return result;
    }),
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectCloneListAtom,
});

const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);

/**
 * Pass `revision` for a host file whose bytes can change under the same path; each new
 * revision re-mints the URL so the image reloads.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
  delivery?: "web-document",
): AssetUrlState {
  const fileAccessSession = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const blocked = blockedAssetUrlState(resource, fileAccess);
  const connectionPhase = fileEnvironment.presentation?.connection.phase ?? "available";
  const result = useAtomValue<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId, input: { resource }, revision }),
  );
  const shared = blocked ?? checkedAssetState(result, environmentId);
  const local = useVerifiedLocalAsset(
    shared._tag === "Success" && delivery !== "web-document" ? shared.url : null,
  );
  return deriveAssetUrlState({
    connectionPhase,
    shared:
      local.status === "failed"
        ? { _tag: "Failure" }
        : shared._tag === "Success"
          ? delivery === "web-document"
            ? shared
            : local.status === "ready"
              ? { ...shared, url: local.uri }
              : { _tag: "Loading" }
          : shared._tag === "Failure" && result.waiting
            ? { _tag: "Loading" }
            : shared,
  });
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const state = checkedAssetState(
      await createUrl({ environmentId, input: { resource } }),
      environmentId,
    );
    return state._tag === "Success" ? state.url : null;
  };
}

/**
 * {@link useRefreshAssetUrl} for async tasks that resolve several resources at once. Resolves
 * null without a connection and rejects with the server's error when it refuses the URL.
 */
export async function refreshAssetUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
  signal?: AbortSignal,
): Promise<string | null> {
  const connectionAtom = environmentSession.preparedConnectionValueAtom(environmentId);
  if (appAtomRegistry.get(connectionAtom)._tag === "None") return null;
  const atom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    label: atom.label?.[0] ?? "asset url",
    refresh: true,
    reportFailure: false,
    ...(signal ? { signal } : {}),
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const state = checkedAssetState(result, environmentId);
  return state._tag === "Success" ? state.url : null;
}

function checkedAssetState(
  result: Parameters<typeof assetUrlStateFromResult>[0],
  environmentId: EnvironmentId | null,
) {
  if (result._tag !== "Success" || environmentId === null) {
    return assetUrlStateFromResult(result, null);
  }
  const url = issuedMobileAssetUrl(environmentId, result.value);
  if (url === null) return { _tag: "Failure" } as const;
  const state = assetUrlStateFromResult(result, url);
  return state._tag === "Success" ? { ...state, url } : state;
}

export interface AuthorizedAssetUrl {
  readonly url: string;
  readonly authorizedAt: number;
}

interface FreshAssetUrlKey {
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  /** Reauthorize on a new connection instead of reusing an older signed URL. */
  readonly httpBaseUrl: string | null;
  /** Bumped by Retry so a file replaced on disk is reauthorized. */
  readonly revision: number;
}

class AssetUrlUnavailableError extends Schema.TaggedError<AssetUrlUnavailableError>()(
  "AssetUrlUnavailableError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const freshAssetUrlFamily = Atom.family((key: FreshAssetUrlKey) =>
  Atom.make(
    Effect.tryPromise({
      try: async (signal) =>
        key.environmentId === null
          ? null
          : await refreshAssetUrl(key.environmentId, key.resource, signal).catch(() => null),
      catch: (cause) =>
        new AssetUrlUnavailableError({
          message: cause instanceof Error ? cause.message : "The attachment is unavailable.",
          cause,
        }),
    }).pipe(
      Effect.flatMap((url) =>
        url
          ? Effect.map(Clock.currentTimeMillis, (authorizedAt): AuthorizedAssetUrl => ({
              url,
              authorizedAt,
            }))
          : Effect.fail(
              new AssetUrlUnavailableError({
                message: "Reconnect to this environment and try again.",
              }),
            ),
      ),
    ),
  ).pipe(Atom.withLabel("fresh-asset-url")),
);

const noFreshAssetUrl = Atom.make(
  AsyncResult.initial<AuthorizedAssetUrl, AssetUrlUnavailableError>(),
).pipe(Atom.withLabel("fresh-asset-url:none"));
const noSessionGeneration = Atom.make(0);

/**
 * A signed URL minted when the reader mounts, not a cached one: cached links can
 * expire while the client is suspended.
 */
export function useFreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision: number,
): AsyncResult.AsyncResult<AuthorizedAssetUrl, Error> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const atom =
    resource === null
      ? noFreshAssetUrl
      : freshAssetUrlFamily({ environmentId, resource, httpBaseUrl, revision });
  // Minting fails at once while the environment is unreachable; mint again once a new session is
  // up instead of keeping the error until Retry.
  const sessionGeneration =
    environmentId === null
      ? noSessionGeneration
      : environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    if (AsyncResult.isFailure(appAtomRegistry.get(atom))) appAtomRegistry.refresh(atom);
  });
  return useAtomValue(atom);
}
