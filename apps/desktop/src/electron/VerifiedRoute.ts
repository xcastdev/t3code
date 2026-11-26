// @effect-diagnostics nodeBuiltinImport:off -- Electron's verifier needs synchronous X.509 key extraction.
import * as NodeCrypto from "node:crypto";
import type { VerifiedRouteBinding } from "@t3tools/contracts";
import { RELAY_ADMISSION_PATH } from "@t3tools/contracts/relay";
import type { Session } from "electron";

export interface VerifiedRouteEnrollment {
  readonly origin: string;
  readonly environmentId?: string;
  readonly hostname: string;
  readonly transportRole?: NonNullable<VerifiedRouteBinding["transportRole"]>;
  readonly spkiSha256: string;
}

const normalizeHostname = (hostname: string) => hostname.replace(/^\[|\]$|\.+$/g, "");

const invalid = () => new Error("Invalid T3CODE_DESKTOP_VERIFIED_ROUTE enrollment.");

export function parseVerifiedRouteEnrollments(
  value: string | undefined,
): ReadonlyArray<VerifiedRouteEnrollment> {
  if (value === undefined) return [];
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw invalid();
  }
  const bindings = (Array.isArray(input) ? input : [input]).map(parseEnrollment);
  const origins = new Set<string>();
  const pinsByHost = new Map<string, string>();
  for (const binding of bindings) {
    const pin = pinsByHost.get(binding.hostname);
    if (origins.has(binding.origin) || (pin !== undefined && pin !== binding.spkiSha256)) {
      throw invalid();
    }
    origins.add(binding.origin);
    pinsByHost.set(binding.hostname, binding.spkiSha256);
  }
  return bindings;
}

function parseEnrollment(input: unknown): VerifiedRouteEnrollment {
  if (
    typeof input !== "object" ||
    input === null ||
    !("origin" in input) ||
    typeof input.origin !== "string" ||
    !("spkiSha256" in input) ||
    typeof input.spkiSha256 !== "string"
  ) {
    throw invalid();
  }
  const environmentId = "environmentId" in input ? input.environmentId : undefined;
  if (
    environmentId !== undefined &&
    (typeof environmentId !== "string" || !environmentId || environmentId !== environmentId.trim())
  ) {
    throw invalid();
  }
  const transportRole = "transportRole" in input ? input.transportRole : undefined;
  if (
    transportRole !== undefined &&
    (environmentId === undefined || (transportRole !== "direct" && transportRole !== "relay"))
  ) {
    throw invalid();
  }
  const origin = URL.parse(input.origin);
  const pin = Buffer.from(input.spkiSha256, "base64");
  if (
    origin?.protocol !== "https:" ||
    origin.origin !== input.origin ||
    origin.hostname.endsWith(".") ||
    pin.length !== 32 ||
    pin.toString("base64") !== input.spkiSha256
  ) {
    throw invalid();
  }
  return {
    origin: origin.origin,
    ...(environmentId === undefined ? {} : { environmentId }),
    hostname: normalizeHostname(origin.hostname),
    ...(transportRole === undefined ? {} : { transportRole }),
    spkiSha256: input.spkiSha256,
  };
}

export function isVerifiedRouteHost(url: URL, enrollment: VerifiedRouteEnrollment): boolean {
  return normalizeHostname(url.hostname) === enrollment.hostname;
}

export function installVerifiedRoute(
  network: Pick<Session, "setCertificateVerifyProc"> & {
    readonly webRequest: Pick<Session["webRequest"], "onBeforeRequest" | "onHeadersReceived">;
  },
  enrollments: ReadonlyArray<VerifiedRouteEnrollment>,
): void {
  const byOrigin = new Map(enrollments.map((binding) => [binding.origin, binding]));
  const pinsByHost = new Map(
    enrollments.map((binding) => [binding.hostname, Buffer.from(binding.spkiSha256, "base64")]),
  );
  const routeFor = (url: URL) => byOrigin.get(url.origin.replace(/^wss:/, "https:"));

  network.setCertificateVerifyProc(({ hostname, certificate, errorCode }, callback) => {
    const pin = pinsByHost.get(normalizeHostname(hostname));
    if (pin === undefined) {
      callback(-3);
      return;
    }
    if (errorCode !== 0) {
      callback(-2);
      return;
    }
    let matches = false;
    try {
      const key = new NodeCrypto.X509Certificate(certificate.data).publicKey.export({
        format: "der",
        type: "spki",
      });
      matches = NodeCrypto.createHash("sha256").update(key).digest().equals(pin);
    } catch {
      // An unreadable certificate cannot satisfy the enrollment.
    }
    // A pin match still needs Chromium's full verdict, including Certificate Transparency.
    callback(matches ? -3 : -2);
  });

  // The certificate verifier sees hostnames only. Reserve this host for the exact enrolled authority.
  network.webRequest.onBeforeRequest(({ url: value, method }, callback) => {
    const url = URL.parse(value);
    const route = url === null ? undefined : routeFor(url);
    const cancel =
      url !== null &&
      pinsByHost.has(normalizeHostname(url.hostname)) &&
      (route === undefined ||
        url.username !== "" ||
        url.password !== "" ||
        (route.transportRole === "relay" &&
          !(method === "HEAD" && url.href === route.origin + RELAY_ADMISSION_PATH)));
    callback({ cancel });
  });

  network.webRequest.onHeadersReceived((details, callback) => {
    const { statusCode, initiatorOrigin, resourceType, responseHeaders } = details;
    const url = URL.parse(details.url);
    const enrollment = url === null ? undefined : routeFor(url);
    if (enrollment !== undefined && statusCode >= 300 && statusCode < 400 && statusCode !== 304) {
      callback({ cancel: true });
      return;
    }
    const embedder =
      initiatorOrigin === "t3code://app" || initiatorOrigin === "t3code-dev://app"
        ? initiatorOrigin
        : initiatorOrigin === "null" &&
            /^t3code(?:-dev)?:\/\/app(?:\/|$)/.test(details.webContents?.getURL() ?? "")
          ? "*"
          : undefined;
    if (
      enrollment?.environmentId !== undefined &&
      url?.origin === enrollment.origin &&
      /^\/api\/assets\/[^/]+\/[^/]/.test(url.pathname) &&
      resourceType === "subFrame" &&
      embedder !== undefined &&
      responseHeaders !== undefined &&
      Object.entries(responseHeaders).some(
        ([name, values]) =>
          name.toLowerCase() === "content-type" &&
          values.some((value) => /^text\/html(?:;|$)/i.test(value)),
      )
    ) {
      // Let the app's iframe require a stricter policy while retaining the server's sandbox.
      const headers = Object.fromEntries(
        Object.entries(responseHeaders).filter(
          ([name]) => !["allow-csp-from", "referrer-policy"].includes(name.toLowerCase()),
        ),
      );
      callback({
        cancel: false,
        responseHeaders: {
          ...headers,
          "Allow-CSP-From": [embedder],
          "Referrer-Policy": ["no-referrer"],
        },
      });
      return;
    }
    callback({ cancel: false });
  });
}
