// @effect-diagnostics nodeBuiltinImport:off -- The signed request requires per-connection TLS identity checks.
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";

import { PREVIEW_URL_MAX_LENGTH, VerifiedRouteBindingSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { BrowserContext } from "playwright-core";

const VIEW_ORIGIN = "https://t3-verified-preview.invalid";
const VIEW_PREFIX = "/asset/";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_RANGE_BYTES = 8n * 1024n * 1024n;
const REQUEST_TIMEOUT_MS = 15_000;
const ASSET_PATH = /^(\/api\/assets\/[\w-]+\.[\w-]+\/)([^/]+)$/;
const PASSIVE_RESOURCES = new Set(["image", "stylesheet", "font", "media"]);
const RESPONSE_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
] as const;
const VIEW_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin";

const decodeEnrollment = Schema.decodeUnknownOption(
  Schema.fromJsonString(VerifiedRouteBindingSchema),
);

export function readEnrollment(enrollment: string | undefined) {
  const binding = decodeEnrollment(enrollment);
  if (binding._tag === "None" || binding.value.leafSpkiSha256 === undefined) return null;
  return { ...binding.value, leafSpkiSha256: binding.value.leafSpkiSha256 };
}

export function prepare(issuedUrl: string, enrollment: ReturnType<typeof readEnrollment>) {
  const upstream = URL.parse(issuedUrl);
  if (upstream?.protocol !== "https:" || upstream.username || upstream.password || upstream.hash) {
    return null;
  }
  const path = ASSET_PATH.exec(upstream.pathname);
  if (!path?.[1] || !path[2] || /%(?:2f|5c|00)/i.test(path[2])) return null;
  if (enrollment?.httpsOrigin !== upstream.origin) return null;
  const viewUrl = new URL(VIEW_PREFIX + path[2], VIEW_ORIGIN);
  if (viewUrl.href.length > PREVIEW_URL_MAX_LENGTH) viewUrl.pathname = VIEW_PREFIX + "document";
  return {
    upstream,
    assetPrefix: path[1],
    viewUrl,
    environmentId: enrollment.environmentId,
    pin: Buffer.from(enrollment.leafSpkiSha256, "base64"),
    html: /\.html?$/i.test(path[2]),
  };
}

export type VerifiedAssetNavigation = NonNullable<ReturnType<typeof prepare>>;

function readPinned(
  url: URL,
  pin: Buffer,
  method: "GET" | "HEAD",
  range: string | undefined,
  closed: AbortSignal,
) {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
    (resolve, reject) => {
      const request = NodeHttps.request(
        url,
        {
          agent: false,
          method,
          headers: { "accept-encoding": "identity", ...(range === undefined ? {} : { range }) },
          rejectUnauthorized: true,
          signal: AbortSignal.any([closed, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          checkServerIdentity(host, cert) {
            const hostnameError = NodeTls.checkServerIdentity(host, cert);
            if (hostnameError) return hostnameError;
            const actual = NodeCrypto.createHash("sha256")
              .update(
                new NodeCrypto.X509Certificate(cert.raw).publicKey.export({
                  format: "der",
                  type: "spki",
                }),
              )
              .digest();
            return actual.equals(pin) ? undefined : new Error("Verified preview TLS key mismatch");
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (
            status < 200 ||
            (status >= 300 && status !== 416) ||
            (response.headers["content-encoding"] !== undefined &&
              response.headers["content-encoding"] !== "identity") ||
            (method !== "HEAD" && Number(response.headers["content-length"]) > MAX_BODY_BYTES)
          ) {
            response.destroy();
            reject(new Error("Verified preview refused the upstream response"));
            return;
          }
          const headers: Record<string, string> = {
            "cache-control": "no-store",
            "content-security-policy": [response.headers["content-security-policy"], VIEW_CSP]
              .filter(Boolean)
              .join(", "),
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          };
          for (const name of RESPONSE_HEADERS) {
            const value = response.headers[name];
            if (value !== undefined) headers[name] = value;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("error", reject);
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length <= MAX_BODY_BYTES) chunks.push(chunk);
            else response.destroy(new Error("Verified preview response exceeds its byte limit"));
          });
          response.on("end", () =>
            resolve({ status, headers, body: Buffer.concat(chunks, length) }),
          );
        },
      );
      request.once("error", reject);
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new Error("Verified preview refused an upgrade"));
      });
      // Release the HTTP request only after this socket passes chain, hostname and pin checks.
      request.once("socket", (socket) => socket.once("secureConnect", () => request.end()));
    },
  );
}

export function boundedRange(range: string) {
  const match = /^bytes=(\d{0,19})-(\d{0,19})$/.exec(range);
  if (!match) return null;
  const [, first, last] = match;
  if (!first) {
    if (!last) return null;
    const suffix = BigInt(last);
    return `bytes=-${suffix > MAX_RANGE_BYTES ? MAX_RANGE_BYTES : suffix}`;
  }
  const start = BigInt(first);
  const limit = start + MAX_RANGE_BYTES - 1n;
  const end = last ? BigInt(last) : limit;
  return end < start ? null : `bytes=${start}-${end > limit ? limit : end}`;
}

export async function install(context: BrowserContext, asset: VerifiedAssetNavigation) {
  const closed = new AbortController();
  context.once("close", () => closed.abort());
  let inFlight = 0;
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.route("**/*", async (route, request) => {
    const url = URL.parse(request.url());
    const method = request.method();
    if (
      url?.origin !== VIEW_ORIGIN ||
      url.username ||
      url.password ||
      (method !== "GET" && method !== "HEAD") ||
      inFlight >= 8
    ) {
      await route.abort();
      return;
    }
    let upstream: URL;
    if (url.href === asset.viewUrl.href) {
      upstream = asset.upstream;
    } else if (
      asset.html &&
      PASSIVE_RESOURCES.has(request.resourceType()) &&
      url.pathname.startsWith(VIEW_PREFIX) &&
      url.pathname.length > VIEW_PREFIX.length
    ) {
      // The issuer still authorizes each relative path under the original signed capability.
      upstream = new URL(asset.upstream);
      upstream.pathname = asset.assetPrefix + url.pathname.slice(VIEW_PREFIX.length);
      upstream.search = url.search;
    } else {
      await route.abort();
      return;
    }

    const requestedRange = request.headers().range;
    const range = requestedRange === undefined ? undefined : boundedRange(requestedRange);
    if (range === null) {
      await route.abort();
      return;
    }
    inFlight++;
    try {
      const response = await readPinned(upstream, asset.pin, method, range, closed.signal);
      await route.fulfill(response);
    } catch {
      await route.abort().catch(() => undefined);
    } finally {
      inFlight--;
    }
  });
}
