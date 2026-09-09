import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

let desktopBearerTokenPromise: Promise<string> | null = null;
let desktopPrimaryAuthRecoveryNotified = false;

export const DESKTOP_PRIMARY_AUTH_REQUIRED_EVENT = "t3-primary-auth-required";

export function isDesktopPrimaryAttached(): boolean {
  if (typeof window === "undefined") return false;
  const primary = window.desktopBridge
    ?.getLocalEnvironmentBootstraps()
    .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  return primary?.ownership === "attached";
}

export function notifyDesktopPrimaryAuthRequired(): void {
  if (
    !isDesktopPrimaryAttached() ||
    desktopPrimaryAuthRecoveryNotified ||
    typeof window === "undefined"
  ) {
    return;
  }
  desktopPrimaryAuthRecoveryNotified = true;
  window.dispatchEvent(new Event(DESKTOP_PRIMARY_AUTH_REQUIRED_EVENT));
}

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw error;
  });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}

export function clearDesktopPrimaryBearerToken(): void {
  desktopBearerTokenPromise = null;
}

export function resetDesktopPrimaryAuthRecoveryNotification(): void {
  desktopPrimaryAuthRecoveryNotified = false;
}
