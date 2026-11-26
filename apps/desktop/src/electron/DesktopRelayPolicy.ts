// @effect-diagnostics nodeBuiltinImport:off -- Privileged startup validates credential files before creating Electron windows.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";

import * as Redacted from "effect/Redacted";
import { RELAY_ADMISSION_PATH } from "@t3tools/contracts/relay";
import {
  RELAY_MEDIA_DOWNLOAD_HEADER,
  RELAY_MEDIA_DOWNLOAD_VALUE,
} from "@t3tools/shared/relayMediaDownload";
import type { VerifiedRouteEnrollment } from "./VerifiedRoute.ts";

const invalidConfig = () =>
  new Error("Invalid desktop relay forwarding configuration or credential file.");

function readCredential(file: string, platform: NodeJS.Platform): string {
  if (
    !NodePath.isAbsolute(file) ||
    NodePath.normalize(file) !== file ||
    (platform === "win32" && !/^[A-Za-z]:\\/.test(file))
  )
    throw invalidConfig();
  const resolved = NodeFS.realpathSync.native(file);
  if (platform === "win32" ? resolved.toLowerCase() !== file.toLowerCase() : resolved !== file) {
    throw invalidConfig();
  }
  const before = NodeFS.lstatSync(file);
  if (!before.isFile()) throw invalidConfig();
  const fd = NodeFS.openSync(
    file,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = NodeFS.fstatSync(fd);
    if (
      !stat.isFile() ||
      before.ino !== stat.ino ||
      before.dev !== stat.dev ||
      (platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || (stat.uid !== 0 && stat.uid !== process.getuid?.()))) ||
      stat.size === 0 ||
      stat.size > 514
    )
      throw invalidConfig();
    const data = Buffer.alloc(515);
    const length = NodeFS.readSync(fd, data);
    try {
      const credential = data
        .subarray(0, length)
        .toString("latin1")
        .replace(/\r?\n$/, "");
      if (length !== stat.size || !/^[A-Za-z0-9._~+/=-]{1,512}$/.test(credential))
        throw invalidConfig();
      return credential;
    } finally {
      data.fill(0);
    }
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function loadDesktopRelayCredentials(
  config: string | undefined,
  enrollments: readonly VerifiedRouteEnrollment[],
  platform: NodeJS.Platform,
): ReadonlyMap<string, Redacted.Redacted<string>> {
  if (config === undefined) return new Map();
  try {
    if (config.length > 65_536) throw invalidConfig();
    const entries: unknown = JSON.parse(config);
    if (!Array.isArray(entries) || entries.length > 64) throw invalidConfig();
    const result = new Map<string, Redacted.Redacted<string>>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Object.keys(entry).length !== 4)
        throw invalidConfig();
      const match = enrollments.find(
        (binding) =>
          binding.transportRole === "relay" &&
          binding.origin === entry?.origin &&
          binding.environmentId === entry?.environmentId &&
          binding.spkiSha256 === entry?.spkiSha256,
      );
      if (
        match === undefined ||
        typeof entry.credentialFile !== "string" ||
        result.has(match.origin)
      ) {
        throw invalidConfig();
      }
      result.set(match.origin, Redacted.make(readCredential(entry.credentialFile, platform)));
    }
    return result;
  } catch {
    throw invalidConfig();
  }
}

export const DESKTOP_RELAY_CHUNK = 64 * 1024;
export const DESKTOP_RELAY_SOCKET_LIMIT = 16 * 1024 * 1024;
export const DESKTOP_RELAY_HTTP_LIMIT = 512 * 1024 * 1024;
const HTTP_READ = new Set([
  "/.well-known/t3/environment",
  "/api/auth/session",
  "/api/connect/link-state",
  "/api/orchestration/shell",
  "/api/preview-stream/download",
  "/api/projects",
  "/api/voice/cloud/keys",
  "/api/voice/cloud/openrouter/models",
  "/api/voice/models",
  "/api/voice/status",
]);
const HTTP_POST = new Set([
  "/oauth/token",
  "/api/auth/clients/revoke",
  "/api/auth/clients/revoke-others",
  "/api/auth/connect-devices/approve",
  "/api/auth/connect-devices/revoke",
  "/api/auth/pairing-links/revoke",
  "/api/auth/pairing-token",
  "/api/auth/websocket-ticket",
  "/api/auth/websocket-ticket/media",
  "/api/auth/websocket-ticket/rpc",
  "/api/connect/link-proof",
  "/api/connect/preferences",
  "/api/connect/reachability",
  "/api/connect/relay-config",
  "/api/connect/unlink",
  "/api/preview-stream/upload",
  "/api/projects/mutate",
  "/api/pull-requests/diff",
  "/api/voice/acceleration",
  "/api/voice/model-unload-timeout",
  "/api/voice/models/cancel",
  "/api/voice/models/download",
  "/api/voice/models/link",
  "/api/voice/models/prepare",
  "/api/voice/models/remove",
  "/api/voice/models/select",
  "/api/voice/post-process",
  "/api/voice/transcribe",
]);
const DEVICE_READ = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api(?:\/(?:screenshot|event-log(?:\/events)?))?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(?:stream\.(?:mjpeg|avcc)|config|health|ax|foreground|panel\/[13]\/stream\.avcc)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/(?:health|api(?:\/(?:devices|screenshot|stream-mode|stream-settings|accessibility|fold))?)$/,
];
const DEVICE_POST = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(?:offer|close)$/,
  /^\/vendor\/serve-emu\/(?:webrtc\/(?:offer|close)|api\/(?:screenshot|stream-mode|stream-settings|fold))$/,
];
const THREAD_READ = /^\/api\/orchestration\/threads\/[^/]+(?:\/(?:transcript|bounded|history))?$/;
const CLOUD_VOICE_POST = /^\/api\/voice\/cloud\/[^/]+\/(?:key|transcribe)$/;
const WS_PATH = new Set([
  "/ws",
  "/ws/voice",
  "/api/preview-stream/ws",
  "/api/device-hub/api/devices/ws",
  "/api/device-hub/vendor/serve-sim/helper/ws",
  "/api/device-hub/vendor/serve-emu/ws",
]);
const UPLOAD = /^\/api\/attachments\/upload\/[\w-]+\.[\w-]+$/;
const ASSET = /^\/api\/assets\/[\w-]+\.[\w-]+\/[^/]+$/;
const HEADER = new Set([
  "accept",
  "accept-language",
  "authorization",
  "baggage",
  "b3",
  "content-type",
  "dpop",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
  RELAY_MEDIA_DOWNLOAD_HEADER,
  "traceparent",
  "tracestate",
  "x-t3-orchestration-protocol",
]);

function parseTarget(input: unknown, protocol: "https:" | "wss:") {
  if (typeof input !== "string" || input.length > 32_768) return null;
  const url = URL.parse(input);
  if (
    url?.protocol !== protocol ||
    url.href !== input ||
    url.hash ||
    url.username ||
    url.password ||
    input.includes("#") ||
    /%0[ad]|%00|%5c/i.test(url.pathname) ||
    url.pathname.startsWith("//")
  )
    return null;
  return {
    url,
    origin: url.origin.replace(/^wss:/, "https:"),
    target: input.slice(url.origin.length),
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 443),
  };
}

export function isRelayMediaTarget(input: string): boolean {
  const parsed = parseTarget(input, "https:");
  return parsed !== null && ASSET.test(parsed.url.pathname);
}

type RawHttp = {
  readonly url: unknown;
  readonly method: unknown;
  readonly headers: unknown;
  readonly body: unknown;
  readonly redirect?: unknown;
};

export function parseRelayHttp(input: RawHttp & { readonly kind?: "http" }) {
  const parsed = parseTarget(input.url, "https:");
  if (parsed === null || typeof input.body !== "boolean" || input.redirect !== undefined)
    return null;
  const { method } = input;
  const { pathname } = parsed.url;
  if (!ASSET.test(pathname) && /%2f/i.test(pathname)) return null;
  const probe = method === "HEAD" && parsed.target === RELAY_ADMISSION_PATH;
  const read = method === "GET" || method === "HEAD";
  const devicePrefix = "/api/device-hub";
  const allowed = pathname.startsWith(devicePrefix + "/")
    ? (read ? DEVICE_READ : DEVICE_POST).some((path) =>
        path.test(pathname.slice(devicePrefix.length)),
      )
    : read
      ? HTTP_READ.has(pathname) || ASSET.test(pathname) || THREAD_READ.test(pathname)
      : HTTP_POST.has(pathname) || UPLOAD.test(pathname) || CLOUD_VOICE_POST.test(pathname);
  if (!probe && (!allowed || (!read && method !== "POST"))) return null;
  if (
    (pathname.startsWith(devicePrefix + "/") || pathname.startsWith("/api/preview-stream/")) &&
    !hasDestinationTicket(parsed.url)
  )
    return null;
  if ((read && input.body) || !Array.isArray(input.headers) || input.headers.length > 24)
    return null;
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const pair of input.headers) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [name, value] = pair;
    if (typeof name !== "string" || typeof value !== "string") return null;
    const key = name.toLowerCase();
    if (!HEADER.has(key) || key in headers || (probe && key !== "accept")) return null;
    bytes += key.length + value.length;
    if (
      bytes > 64 * 1024 ||
      (key === RELAY_MEDIA_DOWNLOAD_HEADER &&
        (method !== "GET" || !ASSET.test(pathname) || value !== RELAY_MEDIA_DOWNLOAD_VALUE)) ||
      (key === "range" && !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(value))
    )
      return null;
    try {
      NodeHttp.validateHeaderValue(key, value);
    } catch {
      return null;
    }
    headers[key] = value;
  }
  return { ...parsed, method, headers, body: input.body, probe };
}

function hasDestinationTicket(url: URL): boolean {
  const tickets = url.searchParams.getAll("wsTicket");
  return tickets.length === 1 && !!tickets[0] && tickets[0].length <= 4_096;
}

export function parseRelaySocket(input: { readonly url: unknown; readonly protocols: unknown }) {
  const parsed = parseTarget(input.url, "wss:");
  if (parsed === null || !WS_PATH.has(parsed.url.pathname) || !hasDestinationTicket(parsed.url))
    return null;
  if (!Array.isArray(input.protocols) || input.protocols.length > 16) return null;
  const protocols = new Set<string>();
  for (const protocol of input.protocols) {
    if (
      typeof protocol !== "string" ||
      protocol.length > 128 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(protocol) ||
      /^t3-relay\./i.test(protocol) ||
      protocols.has(protocol)
    )
      return null;
    protocols.add(protocol);
  }
  return { ...parsed, protocols: [...protocols] };
}

export function relayTlsServerName(hostname: string) {
  return NodeNet.isIP(hostname) ? undefined : hostname;
}
