import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { Atom } from "effect/reactivity";

import { readVerifiedPreviewAsset, verifyPreviewIssuer } from "~/browser/readVerifiedPreviewAsset";
import {
  assertHostedRelayAdmission,
  fetchHostedRelayResource,
  hostedAdmissionRequired,
} from "~/connection/hostedRelayAdmission";
import { requiresDesktopRelayTransport } from "~/connection/environmentTransport";
import { createDesktopRelayMediaLease } from "~/lib/desktopRelayTransport";

import { openLocalMediaLease } from "./hostedMedia/localMediaLease";
import type { MediaDestination } from "./hostedMedia/mediaResponse";

export type AssetSourceKind = "issued" | "static" | MediaDestination;

const staticSlots = Semaphore.makeUnsafe(4);
const STATIC_LOAD_MS = 60_000;

export { environmentRelayAdmissionRequired as requiresAdmittedAsset } from "~/connection/environmentTransport";

class AdmittedAssetUnavailable extends Schema.TaggedError<
  AdmittedAssetUnavailable,
  { readonly brand: unique symbol }
>()("AdmittedAssetUnavailable", {}) {
  override get message() {
    return "Unable to load the asset from the verified environment.";
  }
}

const assetUnavailable = () => new AdmittedAssetUnavailable();

export function readAdmittedStaticAsset(
  environmentId: EnvironmentId,
  issuedUrl: string,
  signal: AbortSignal,
) {
  const upstream = requiresDesktopRelayTransport(issuedUrl)
    ? issuedUrl.split("#", 1)[0]!
    : issuedUrl;
  return Effect.runPromise(
    Effect.tryPromise({
      try: (readSignal) => readVerifiedPreviewAsset(environmentId, upstream, readSignal),
      catch: assetUnavailable,
    }).pipe(staticSlots.withPermit),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(STATIC_LOAD_MS)]) },
  );
}

export async function sanitizeStaticPreviewBlob(blob: Blob, signal: AbortSignal) {
  if (blob.type.split(";", 1)[0] !== "image/svg+xml") return blob;
  const [{ default: purifier }, svg] = await Promise.all([import("dompurify"), blob.text()]);
  signal.throwIfAborted();
  // Object URLs cannot carry the signed response's SVG sandbox header.
  const source = purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  return new Blob([source], { type: "image/svg+xml" });
}

export async function createAdmittedMediaSource(
  environmentId: EnvironmentId,
  issuedUrl: string,
  destination: MediaDestination,
  expiresAt: number,
  signal: AbortSignal,
) {
  const issuer = await verifyPreviewIssuer(environmentId, issuedUrl);
  signal.throwIfAborted();
  if (requiresDesktopRelayTransport(issuedUrl)) {
    const lifetime = expiresAt - Date.now();
    if (lifetime <= 0) throw new Error("The signed media URL expired.");
    const leaseSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.min(lifetime, 60 * 60_000)),
    ]);
    const upstream = issuedUrl.split("#", 1)[0]!;
    const lease = await createDesktopRelayMediaLease(upstream, destination);
    if (leaseSignal.aborted) {
      lease.dispose();
      leaseSignal.throwIfAborted();
    }
    leaseSignal.addEventListener("abort", () => lease.dispose(), { once: true });
    return lease.url + issuer.hash;
  }
  if (!hostedAdmissionRequired(issuedUrl)) throw new Error("The hosted media issuer changed.");
  const admission = assertHostedRelayAdmission({ environmentId, httpsOrigin: issuer.origin });
  if (!admission) throw new Error("The hosted media issuer changed.");
  const local = await openLocalMediaLease(
    destination,
    expiresAt,
    async (method, range, requestSignal) => {
      await verifyPreviewIssuer(environmentId, issuedUrl);
      requestSignal.throwIfAborted();
      if (!hostedAdmissionRequired(issuedUrl)) throw new Error("The hosted media issuer changed.");
      return fetchHostedRelayResource(issuedUrl, {
        method,
        signal: requestSignal,
        ...(range === null ? {} : { headers: { Range: range } }),
      });
    },
    AbortSignal.any([signal, admission]),
  );
  return local + issuer.hash;
}

const localSourceFamily = Atom.family((key: string) => {
  const [environmentId, issuedUrl, kind, expiresAt] = JSON.parse(key) as [
    EnvironmentId,
    string,
    Exclude<AssetSourceKind, "issued">,
    number,
  ];
  return Atom.make((get) => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    get.addFinalizer(() => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
    return Effect.tryPromise({
      try: async () => {
        const signal = controller.signal;
        if (kind !== "static") {
          return createAdmittedMediaSource(environmentId, issuedUrl, kind, expiresAt, signal);
        }
        const blob = await sanitizeStaticPreviewBlob(
          await readAdmittedStaticAsset(environmentId, issuedUrl, signal),
          signal,
        );
        signal.throwIfAborted();
        objectUrl = URL.createObjectURL(blob);
        return objectUrl + new URL(issuedUrl).hash;
      },
      catch: assetUnavailable,
    });
  }).pipe(Atom.setIdleTTL(0));
});

export function admittedAssetSource(
  environmentId: EnvironmentId,
  url: string,
  kind: Exclude<AssetSourceKind, "issued">,
  expiresAt: number,
  attempt = 0,
) {
  return localSourceFamily(JSON.stringify([environmentId, url, kind, expiresAt, attempt]));
}
