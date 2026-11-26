import {
  createDesktopRelayWebSocketConstructor,
  desktopRelayAdmissionRequired,
  fetchDesktopRelayResource,
} from "../lib/desktopRelayTransport";
import {
  fetchHostedRelayResource,
  hostedAdmissionRequired,
  openHostedRelaySocket,
} from "./hostedRelayAdmission";

export function requiresDesktopRelayTransport(url: string): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge?.relayTransport !== undefined &&
    desktopRelayAdmissionRequired(url)
  );
}

export function environmentRelayAdmissionRequired(url: string): boolean {
  return hostedAdmissionRequired(url) || requiresDesktopRelayTransport(url);
}

export function signedTransferCredentials(url: URL): RequestCredentials {
  return typeof window !== "undefined" && url.origin === window.location?.origin
    ? "same-origin"
    : "omit";
}

export function fetchEnvironmentResource(input: RequestInfo | URL, init?: RequestInit) {
  const url = input instanceof Request ? input.url : String(input);
  if (requiresDesktopRelayTransport(url)) {
    return fetchDesktopRelayResource(input, { ...init, redirect: "error" });
  }
  return fetchHostedRelayResource(input, init);
}

let desktopSocketConstructor: typeof WebSocket | undefined;
export function openEnvironmentSocket(url: string, protocols?: string | string[]): WebSocket {
  if (requiresDesktopRelayTransport(url)) {
    const Socket = (desktopSocketConstructor ??= createDesktopRelayWebSocketConstructor());
    return new Socket(url, protocols);
  }
  return openHostedRelaySocket(url, protocols);
}
