export interface VerifiedRoute {
  readonly httpsOrigin: string;
  readonly environmentId: string;
  readonly leafSpkiSha256: string;
}

interface VerifiedRouteEnrollment extends VerifiedRoute {
  readonly relayAdmissionRequired?: true;
}

export function sameVerifiedRoute(left: VerifiedRoute, right: VerifiedRoute): boolean {
  return (
    left.httpsOrigin === right.httpsOrigin &&
    left.environmentId === right.environmentId &&
    left.leafSpkiSha256 === right.leafSpkiSha256
  );
}

function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      url.origin === origin &&
      !url.hostname.endsWith(".") &&
      !url.hostname.includes(":")
    );
  } catch {
    return false;
  }
}

function validBinding(value: unknown): value is VerifiedRouteEnrollment {
  if (value === null || typeof value !== "object") return false;
  if (
    !("httpsOrigin" in value) ||
    typeof value.httpsOrigin !== "string" ||
    !("environmentId" in value) ||
    typeof value.environmentId !== "string" ||
    !("leafSpkiSha256" in value) ||
    typeof value.leafSpkiSha256 !== "string" ||
    ("relayAdmissionRequired" in value && value.relayAdmissionRequired !== true)
  )
    return false;
  return (
    validOrigin(value.httpsOrigin) &&
    value.environmentId.trim() !== "" &&
    value.environmentId.trim() === value.environmentId &&
    /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value.leafSpkiSha256)
  );
}

export function readVerifiedPairing(pairingUrl: string): VerifiedRoute | null {
  let url: URL;
  try {
    url = new URL(pairingUrl);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const pins = fragment.getAll("leafSpkiSha256");
  const environments = fragment.getAll("environmentId");
  if (pins.length === 0 && environments.length === 0) return null;
  const [leafSpkiSha256] = pins;
  const [environmentId] = environments;
  const binding = { httpsOrigin: url.origin, environmentId, leafSpkiSha256 };
  const enrollOnly = fragment.get("enroll") === "1";
  if (
    pins.length !== 1 ||
    environments.length !== 1 ||
    !validBinding(binding) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    (enrollOnly
      ? fragment.getAll("enroll").length !== 1 || fragment.has("token")
      : fragment.has("enroll") || fragment.getAll("token").length !== 1 || !fragment.get("token"))
  ) {
    throw new Error("Invalid verified environment pairing link.");
  }
  return binding;
}

export function isEnrollmentOnlyPairing(url: string): boolean {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("enroll") === "1";
}

export function routeOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    return url.protocol === "wss:" ? new URL(`https://${url.host}`).origin : url.origin;
  } catch {
    return null;
  }
}

const storageKey = "t3code.verified-routes.v1";
const policyKey = "t3code.verified-route-policy.v1";
type RoutePolicy = "verified" | "relay";
const routes = new Map<string, VerifiedRouteEnrollment>();
const policies = new Map<string, RoutePolicy>();
const requiredOrigins = new Set<string>();
let storageUnavailable = false;
let readiness: Promise<void> | undefined;
let refresh: Promise<void> | undefined;
let enrollment: Promise<void> = Promise.resolve();

function readPolicies(raw: string | null): Map<string, RoutePolicy> {
  const saved: unknown = raw == null ? {} : JSON.parse(raw);
  if (saved === null || typeof saved !== "object" || Array.isArray(saved)) {
    throw new Error("Invalid saved verified route policy.");
  }
  const loaded = new Map<string, RoutePolicy>();
  for (const [origin, policy] of Object.entries(saved)) {
    if (!validOrigin(origin) || (policy !== "verified" && policy !== "relay")) {
      throw new Error("Invalid saved verified route policy.");
    }
    loaded.set(origin, policy);
  }
  return loaded;
}

async function persistPolicies(next: Map<string, RoutePolicy>): Promise<void> {
  // Keep a stricter policy in force in this process even if its durable write fails.
  for (const [origin, policy] of next) policies.set(origin, policy);
  const storage = await import("expo-secure-store");
  await storage.setItemAsync(policyKey, JSON.stringify(Object.fromEntries(next)));
}

async function loadVerifiedRoutes(): Promise<void> {
  try {
    const storage = await import("expo-secure-store");
    const [raw, rawPolicy] = await Promise.all([
      storage.getItemAsync(storageKey),
      storage.getItemAsync(policyKey),
    ]);
    const savedPolicies = readPolicies(rawPolicy);
    const nextPolicies = new Map(savedPolicies);
    for (const [origin, policy] of policies) {
      if (policy === "relay" || !nextPolicies.has(origin)) nextPolicies.set(origin, policy);
    }
    for (const [origin, policy] of nextPolicies) policies.set(origin, policy);

    const saved: unknown = raw == null ? [] : JSON.parse(raw);
    if (!Array.isArray(saved)) throw new Error("Invalid saved verified routes.");
    const loaded = new Map<string, VerifiedRouteEnrollment>();
    for (const binding of saved) {
      if (!validBinding(binding) || loaded.has(binding.httpsOrigin)) {
        throw new Error("Invalid saved verified route.");
      }
      const current = routes.get(binding.httpsOrigin);
      loaded.set(
        binding.httpsOrigin,
        current &&
          sameVerifiedRoute(current, binding) &&
          current.relayAdmissionRequired === binding.relayAdmissionRequired
          ? current
          : binding,
      );
      if (binding.relayAdmissionRequired) nextPolicies.set(binding.httpsOrigin, "relay");
      else if (!nextPolicies.has(binding.httpsOrigin)) {
        nextPolicies.set(binding.httpsOrigin, "verified");
      }
    }
    if ([...nextPolicies].some(([origin, policy]) => savedPolicies.get(origin) !== policy)) {
      await persistPolicies(nextPolicies);
    }
    routes.clear();
    for (const [origin, binding] of loaded) routes.set(origin, binding);
    storageUnavailable = false;
  } catch {
    routes.clear();
    storageUnavailable = true;
    throw new Error("Verified route enrollment is unavailable.");
  }
}

export function initializeVerifiedRoutes(): Promise<void> {
  readiness ??= refreshVerifiedRoutes().catch((cause) => {
    readiness = undefined;
    throw cause;
  });
  return readiness;
}

export function refreshVerifiedRoutes(): Promise<void> {
  if (refresh !== undefined) return refresh;
  const pending = enrollment.then(loadVerifiedRoutes);
  enrollment = pending.catch(() => undefined);
  refresh = pending.finally(() => {
    refresh = undefined;
  });
  return refresh;
}

export function verifiedRouteFor(endpoint: string): VerifiedRouteEnrollment | undefined {
  return routes.get(routeOrigin(endpoint) ?? "");
}

export function markVerificationRequired(endpoint: string): void {
  const origin = routeOrigin(endpoint);
  if (origin !== null) requiredOrigins.add(origin);
}

export function verificationRequiredFor(endpoint: string): boolean {
  const origin = routeOrigin(endpoint) ?? "";
  return (
    requiredOrigins.has(origin) ||
    policies.has(origin) ||
    (storageUnavailable && origin.startsWith("https:"))
  );
}

export function relayAdmissionRequiredFor(binding: VerifiedRoute): boolean {
  return policies.get(binding.httpsOrigin) === "relay";
}

export async function readVerifiedRouteForDispatch(
  endpoint: string,
  requireVerified = false,
): Promise<VerifiedRoute | null> {
  await refreshVerifiedRoutes();
  const binding = verifiedRouteFor(endpoint);
  if (binding === undefined && (requireVerified || verificationRequiredFor(endpoint))) {
    throw new Error("Verified route enrollment is unavailable.");
  }
  return binding ?? null;
}

export async function supportsVerifiedRoutes(): Promise<boolean> {
  const { requireOptionalNativeModule, Platform } = await import("expo");
  if (Platform.OS !== "ios" && Platform.OS !== "android") return false;
  const native = requireOptionalNativeModule<Record<string, unknown>>(
    Platform.OS === "ios" ? "T3WebSocket" : "T3VerifiedNetwork",
  );
  return (
    typeof native?.connectVerified === "function" &&
    typeof native.startVerifiedRequest === "function" &&
    typeof native.cancelVerifiedRequest === "function"
  );
}

export async function readVerifiedRouteEnrollment(
  endpoint: string,
): Promise<VerifiedRouteEnrollment | null> {
  try {
    await refreshVerifiedRoutes();
    return verifiedRouteFor(endpoint) ?? null;
  } catch {
    return null;
  }
}

export function enrollVerifiedRoute({
  httpsOrigin,
  environmentId,
  leafSpkiSha256,
}: VerifiedRoute): Promise<void> {
  const binding = { httpsOrigin, environmentId, leafSpkiSha256 };
  const pending = enrollment.then(async () => {
    if (!validBinding(binding)) throw new Error("Invalid verified route binding.");
    await loadVerifiedRoutes();
    const existing = routes.get(binding.httpsOrigin);
    if (existing !== undefined) {
      if (!sameVerifiedRoute(existing, binding)) {
        throw new Error("This address already has a different verified route binding.");
      }
      return;
    }
    if (!policies.has(binding.httpsOrigin)) {
      await persistPolicies(new Map(policies).set(binding.httpsOrigin, "verified"));
    }
    const storage = await import("expo-secure-store");
    await storage.setItemAsync(storageKey, JSON.stringify([...routes.values(), binding]));
    routes.set(binding.httpsOrigin, binding);
  });
  enrollment = pending.catch(() => undefined);
  return pending;
}

export function requireVerifiedRouteRelayAdmission(binding: VerifiedRoute): Promise<void> {
  const pending = enrollment.then(async () => {
    await loadVerifiedRoutes();
    const existing = routes.get(binding.httpsOrigin);
    if (!existing || !sameVerifiedRoute(existing, binding)) {
      throw new Error("Relay admission requires a matching verified route enrollment.");
    }
    if (relayAdmissionRequiredFor(binding)) return;
    await persistPolicies(new Map(policies).set(binding.httpsOrigin, "relay"));
  });
  enrollment = pending.catch(() => undefined);
  return pending;
}
