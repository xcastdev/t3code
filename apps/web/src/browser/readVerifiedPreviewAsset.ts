import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  environmentRelayAdmissionRequired,
  fetchEnvironmentResource,
  requiresDesktopRelayTransport,
  signedTransferCredentials,
} from "~/connection/environmentTransport";

import {
  supportsOperatorBoundBrowserViewer,
  verifiedRoutePolicy,
} from "~/connection/verifiedRoute";

const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;

export async function verifyPreviewIssuer(environmentId: EnvironmentId, issuedUrl: string) {
  const url = URL.parse(issuedUrl);
  if (
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^\/api\/assets\/[^/]+\/[^/]/.test(url.pathname)
  ) {
    throw new Error("The environment returned an invalid preview URL.");
  }
  const binding = await Effect.runPromise(verifiedRoutePolicy.readEnrollment(url.origin));
  if (
    binding === null ||
    binding.environmentId !== environmentId ||
    binding.httpsOrigin !== url.origin ||
    !(await Effect.runPromise(verifiedRoutePolicy.enforce(binding))) ||
    (typeof window !== "undefined" &&
      window.desktopBridge !== undefined &&
      binding.transportRole === "relay" &&
      !requiresDesktopRelayTransport(issuedUrl))
  ) {
    throw new Error("The preview issuer does not match the installed route policy.");
  }
  return url;
}

export async function prepareVerifiedPreviewSource(
  environmentId: EnvironmentId,
  issuedUrl: string,
  options?: { readonly html?: boolean; readonly signal?: AbortSignal },
): Promise<string | Blob> {
  const url = await verifyPreviewIssuer(environmentId, issuedUrl);
  const signal = options?.signal;
  signal?.throwIfAborted();
  // Both the Electron renderer session and the operator's HTTPS ingress enforce the route.
  if (
    !environmentRelayAdmissionRequired(issuedUrl) &&
    ((typeof window !== "undefined" && window.desktopBridge !== undefined) ||
      (supportsOperatorBoundBrowserViewer(url) &&
        (!options?.html || "csp" in document.createElement("iframe"))))
  ) {
    return issuedUrl;
  }
  return readVerifiedPreviewBytes(issuedUrl, signal);
}

export async function readVerifiedPreviewAsset(
  environmentId: EnvironmentId,
  issuedUrl: string,
  signal?: AbortSignal,
): Promise<Blob> {
  await verifyPreviewIssuer(environmentId, issuedUrl);
  return readVerifiedPreviewBytes(issuedUrl, signal);
}

async function readVerifiedPreviewBytes(issuedUrl: string, signal?: AbortSignal): Promise<Blob> {
  const desktop = typeof window === "undefined" ? undefined : window.desktopBridge;
  signal?.throwIfAborted();
  if (desktop !== undefined && !requiresDesktopRelayTransport(issuedUrl)) {
    const result = await desktop.readMedia(issuedUrl).catch(() => null);
    signal?.throwIfAborted();
    if (result?.status === 200) {
      return new Blob([new Uint8Array(result.data)], { type: result.mimeType });
    }
    throw new Error("Unable to read the file from the verified environment.");
  }
  const response = await fetchEnvironmentResource(issuedUrl, {
    signal: signal ?? null,
    credentials: signedTransferCredentials(new URL(issuedUrl)),
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  }).catch(() => {
    throw new Error("Unable to read the file from the verified environment.");
  });
  if (
    response.status !== 200 ||
    response.body === null ||
    Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("The file is unavailable or too large to preview.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PREVIEW_BYTES) throw new Error("The file is too large to preview.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
}
