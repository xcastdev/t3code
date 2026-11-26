import type { VerifiedRouteBinding } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

import {
  readVerifiedRouteEnrollment,
  readVerifiedRouteForDispatch,
  relayAdmissionRequiredFor,
  requireVerifiedRouteRelayAdmission,
  routeOrigin,
  sameVerifiedRoute,
  type VerifiedRoute,
} from "./verified-route";

export const relayAdmissionHeader = "proxy-authorization";

function credentialKey(origin: string): string {
  const key = btoa(origin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `t3code.relay-admission.v1.${key}`;
}

function validCredential(value: unknown): value is string {
  return typeof value === "string" && /^[!-+\x2d-\x7e]{1,512}$/u.test(value);
}

let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}

export function installNativeRelayAdmission(
  { httpsOrigin, environmentId, leafSpkiSha256 }: VerifiedRoute,
  credential: string,
): Promise<void> {
  const binding = { httpsOrigin, environmentId, leafSpkiSha256 };
  return serialize(async () => {
    if (!validCredential(credential)) throw new Error("Invalid relay admission credential.");
    // Persist the requirement first so a partial install blocks the route.
    await requireVerifiedRouteRelayAdmission(binding);
    const storage = await import("expo-secure-store");
    try {
      await storage.setItemAsync(
        credentialKey(httpsOrigin),
        JSON.stringify({ ...binding, credential }),
      );
    } catch {
      throw new Error("Unable to save the relay admission credential.");
    }
  });
}

async function readAdmissionRecord(binding: VerifiedRoute): Promise<string | null> {
  try {
    const storage = await import("expo-secure-store");
    const raw = await storage.getItemAsync(credentialKey(binding.httpsOrigin));
    // A legacy credential may survive a restore of the pin record that carried its marker.
    if (raw !== null && !relayAdmissionRequiredFor(binding)) {
      await requireVerifiedRouteRelayAdmission(binding);
    }
    return raw;
  } catch {
    throw new Error("Relay admission credential is unavailable.");
  }
}

export function clearNativeRelayAdmission(binding: VerifiedRoute): Promise<void> {
  return serialize(async () => {
    const current = await readVerifiedRouteForDispatch(binding.httpsOrigin);
    if (!current || !sameVerifiedRoute(current, binding)) {
      throw new Error("Relay admission requires a matching verified route enrollment.");
    }
    if (!relayAdmissionRequiredFor(current) && (await readAdmissionRecord(current)) === null)
      return;
    const storage = await import("expo-secure-store");
    // Keep the requirement even after the credential is removed.
    await storage.deleteItemAsync(credentialKey(current.httpsOrigin));
  });
}

export function readNativeRelayAdmission(
  binding: VerifiedRoute,
): Promise<Redacted.Redacted<string> | null> {
  return serialize(async () => {
    const current = await readVerifiedRouteForDispatch(binding.httpsOrigin);
    if (!current || !sameVerifiedRoute(current, binding)) {
      throw new Error("Verified route enrollment is unavailable.");
    }
    const raw = await readAdmissionRecord(current);
    if (raw === null && !relayAdmissionRequiredFor(current)) return null;
    try {
      const saved: Partial<VerifiedRoute> & { credential?: unknown } = JSON.parse(raw ?? "null");
      if (
        saved &&
        saved.httpsOrigin === current.httpsOrigin &&
        saved.environmentId === current.environmentId &&
        saved.leafSpkiSha256 === current.leafSpkiSha256 &&
        validCredential(saved.credential)
      ) {
        return Redacted.make(saved.credential);
      }
    } catch {
      // Storage and parse errors can contain the secret.
    }
    throw new Error("Relay admission credential is unavailable.");
  });
}

export async function readNativeVerifiedRouteBinding(
  httpsOrigin: string,
): Promise<VerifiedRouteBinding | null> {
  const binding = await readVerifiedRouteEnrollment(httpsOrigin);
  if (binding === null) return null;
  if (relayAdmissionRequiredFor(binding)) return { ...binding, transportRole: "relay" };
  try {
    // A surviving legacy admission promotes the ledger before the route can be ranked.
    const admission = await readNativeRelayAdmission(binding);
    return { ...binding, transportRole: admission === null ? "direct" : "relay" };
  } catch {
    return relayAdmissionRequiredFor(binding) ? { ...binding, transportRole: "relay" } : binding;
  }
}

export function assertRelayAdmissionEndpoint(
  binding: VerifiedRoute,
  endpoint: string,
  protocol: "https:" | "wss:",
): void {
  const url = new URL(endpoint);
  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.hash ||
    routeOrigin(endpoint) !== binding.httpsOrigin
  ) {
    throw new Error("Request does not match the relay admission binding.");
  }
}
