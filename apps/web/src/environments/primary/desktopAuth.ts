import type { DesktopAttachedBackendTarget } from "@t3tools/contracts";

import { readPrimaryEnvironmentTarget } from "./target";

let desktopBearerTokenPromise: Promise<string> | null = null;

export class DesktopAttachedCredentialTargetMismatchError extends Error {
  constructor() {
    super(
      "The attached T3 Code server changed while a request was being prepared. Reconnect, or open Settings → Connections to refresh it.",
    );
    this.name = "DesktopAttachedCredentialTargetMismatchError";
  }
}

function sameAttachedTarget(
  left: DesktopAttachedBackendTarget,
  right: DesktopAttachedBackendTarget,
): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.environmentId === right.environmentId &&
    left.attachmentRevision === right.attachmentRevision
  );
}

/**
 * Reads the desktop primary credential.
 *
 * An attached server's bearer is never cached here: each call hands the main process
 * the exact attachment captured from the bootstrap, and it refuses unless that is still
 * the current, identity-verified attachment. `expected` pins the call to a target the
 * caller already used (a request URL or a registered connection), so a token for a
 * newer attachment can never be returned for an older one; `"managed"` pins it to the
 * bundled server.
 */
export function readDesktopPrimaryBearerToken(
  expected?: DesktopAttachedBackendTarget | "managed",
): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  let attached: DesktopAttachedBackendTarget | undefined;
  try {
    attached = readPrimaryEnvironmentTarget()?.attached;
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    expected === "managed"
      ? attached !== undefined
      : expected !== undefined &&
        (attached === undefined || !sameAttachedTarget(attached, expected))
  )
    return Promise.reject(new DesktopAttachedCredentialTargetMismatchError());
  if (attached !== undefined) {
    desktopBearerTokenPromise = null;
    return bridge.getLocalEnvironmentBearerToken(attached);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw error;
  });
  return desktopBearerTokenPromise;
}

/** The current attachment when `url` is addressed to it; undefined for managed targets. */
export function attachedTargetForRequestUrl(url: string): DesktopAttachedBackendTarget | undefined {
  const attached = readPrimaryEnvironmentTarget()?.attached;
  if (attached === undefined) return undefined;
  if (new URL(url).origin !== new URL(attached.httpBaseUrl).origin) {
    throw new DesktopAttachedCredentialTargetMismatchError();
  }
  return attached;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
