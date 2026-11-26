import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  makeRevisionedAssetUrlFamily,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  admittedAssetSource,
  type AssetSourceKind,
  requiresAdmittedAsset,
} from "./admittedAssetSource";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & {
  readonly waiting?: boolean;
  readonly learnedRoute?: true;
  readonly localSource?: true;
};

const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);

/**
 * Pass `revision` for a workspace file whose bytes can change under the same
 * path; each new revision gets a freshly minted URL.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
  kind: AssetSourceKind = "static",
  sourceAttempt = 0,
): AssetUrlState {
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId, input: { resource }, revision }),
  );
  const learnedRoute = result._tag === "Success" && isLearnedAssetGrant(result.value);
  const state = assetUrlStateFromResult(
    result,
    learnedRoute
      ? (URL.parse(result.value.relativeUrl)?.origin ?? "")
      : preparedConnection._tag === "Some"
        ? preparedConnection.value.httpBaseUrl
        : null,
  );
  const issuedUrl =
    state._tag === "Success"
      ? learnedRoute && result._tag === "Success"
        ? result.value.relativeUrl
        : state.url
      : null;
  const materialize =
    blocked === null &&
    kind !== "issued" &&
    environmentId !== null &&
    issuedUrl !== null &&
    state._tag === "Success" &&
    requiresAdmittedAsset(issuedUrl);
  const source = useAtomValue(
    materialize
      ? admittedAssetSource(environmentId, issuedUrl, kind, state.expiresAt, sourceAttempt)
      : EMPTY_ASSET_URL_ATOM,
  );
  if (blocked !== null) return blocked;
  if (materialize) {
    if (source._tag === "Success") {
      return {
        ...state,
        url: source.value,
        localSource: true,
        ...(result.waiting ? { waiting: true } : {}),
      };
    }
    if (source._tag === "Failure") return { _tag: "Failure" };
    return { _tag: "Loading" };
  }
  return {
    ...state,
    ...(result.waiting ? { waiting: true } : {}),
    ...(learnedRoute && state._tag === "Success"
      ? { url: result.value.relativeUrl, learnedRoute: true }
      : {}),
  };
}

export function isLearnedAssetGrant(value: object): boolean {
  return "learnedRoute" in value && value.learnedRoute === true;
}

export function useAssetGrantRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<{ url: string; learnedRoute: boolean; expiresAt?: number } | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const learnedRoute = isLearnedAssetGrant(result.value);
    const url = learnedRoute
      ? result.value.relativeUrl
      : resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
    return url === null ? null : { url, learnedRoute, expiresAt: result.value.expiresAt };
  };
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const refresh = useAssetGrantRefresh(environmentId, resource);
  return async () => (await refresh())?.url ?? null;
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = canReadFiles
    ? resources
    : resources.filter((resource) => !isFileResource(resource));
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  const baseUrl = preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const grants = results.map((result) => {
    if (baseUrl === null || !AsyncResult.isSuccess(result)) return null;
    const url = isLearnedAssetGrant(result.value)
      ? result.value.relativeUrl
      : resolveAssetUrl(baseUrl, result.value.relativeUrl);
    return url === null ? null : ([url, result.value.expiresAt] as const);
  });
  const admitted = grants.filter((grant) => grant !== null && requiresAdmittedAsset(grant[0]));
  const sources = useAtomValue(
    admitted.length === 0
      ? emptyAdmittedSources
      : assetSourceCollectionFamily(JSON.stringify([environmentId, admitted])),
  );
  let resultIndex = 0;
  const urls = new Array<string | null>();
  for (const resource of resources) {
    if (!canReadFiles && isFileResource(resource)) {
      urls.push(null);
      continue;
    }
    const grant = grants[resultIndex];
    resultIndex++;
    urls.push(grant ? (sources.has(grant[0]) ? (sources.get(grant[0]) ?? null) : grant[0]) : null);
  }
  return urls;
}

type IssuedAsset = readonly [url: string, expiresAt: number];
const emptyAdmittedSources = Atom.make(new Map<string, string | null>());
const assetSourceCollectionFamily = Atom.family((key: string) => {
  const [environmentId, grants] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<IssuedAsset>];
  return Atom.make(
    (get) =>
      new Map(
        grants.map(([url, expiresAt]) => [
          url,
          AsyncResult.getOrElse(
            get(admittedAssetSource(environmentId, url, "static", expiresAt)),
            () => null,
          ),
        ]),
      ),
  ).pipe(Atom.setIdleTTL(0));
});

function isFileResource(resource: AssetResource): boolean {
  return (
    resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file" ||
    (resource._tag === "native-app-icon" && resource.app._tag === "app-path")
  );
}
