import {
  DESKTOP_PRODUCTION_SCHEME,
  DESKTOP_DEVELOPMENT_SCHEME,
} from "../electron/ElectronProtocol.ts";

export const DESKTOP_ATTACH_HOST = "attach-primary";

let pendingPairingUrl: string | null = null;
const listeners = new Set<(pairingUrl: string) => void>();

export function buildDesktopAttachUrl(
  pairingUrl: string,
  scheme = DESKTOP_PRODUCTION_SCHEME,
): string {
  const url = new URL(`${scheme}://${DESKTOP_ATTACH_HOST}`);
  url.searchParams.set("pairingUrl", pairingUrl.trim());
  return url.toString();
}

export function parseDesktopLaunchIntent(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (
      !new Set([`${DESKTOP_PRODUCTION_SCHEME}:`, `${DESKTOP_DEVELOPMENT_SCHEME}:`]).has(
        url.protocol,
      ) ||
      url.hostname !== DESKTOP_ATTACH_HOST ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== "pairingUrl") ||
      url.searchParams.getAll("pairingUrl").length !== 1
    )
      return null;
    const pairingUrl = url.searchParams.get("pairingUrl")?.trim() ?? "";
    return new URL(pairingUrl).protocol === "http:" ? pairingUrl : null;
  } catch {
    return null;
  }
}

/** Safe before Electron is ready; the startup path consumes it exactly once. */
export function captureDesktopLaunchIntent(raw: string): boolean {
  const pairingUrl = parseDesktopLaunchIntent(raw);
  if (pairingUrl === null) return false;
  if (listeners.size === 0) {
    pendingPairingUrl = pairingUrl;
  } else {
    for (const listener of listeners) listener(pairingUrl);
  }
  return true;
}

export function captureDesktopSecondInstanceLaunchIntent(argv: readonly string[]): boolean {
  const value = argv.find((arg) => captureDesktopLaunchIntent(arg));
  return value !== undefined;
}

export function consumeDesktopLaunchIntent(): string | null {
  const value = pendingPairingUrl;
  pendingPairingUrl = null;
  return value;
}

/**
 * Delivers any URL captured after bootstrap's initial consume, then future
 * attach-primary URLs to the running desktop scope.
 */
export function subscribeDesktopLaunchIntent(listener: (pairingUrl: string) => void): () => void {
  listeners.add(listener);
  const pending = consumeDesktopLaunchIntent();
  if (pending !== null) listener(pending);
  return () => listeners.delete(listener);
}
