// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  materializeAsset,
  type OperationContext,
  type PluginBackendDefinition,
  type PluginWorkerStatus,
  reportStatus,
  type TopicEmitter,
} from "@t3tools/plugin-sdk/backend";

import { type ExportEntry, type ExportFormat, exportRequests } from "../shared/exportFormats.ts";
import { formatHeaders, type HeaderFormat } from "../shared/headerFormats.ts";
import type { BodyInput as ExportBody, HeaderList } from "../shared/httpText.ts";
import { isSensitiveHeader, redactHeaderValue } from "../shared/sensitiveHeaders.ts";
import {
  type CallerContext,
  callerLink,
  type ProxyLink,
  resolveProxy,
} from "../shared/proxyResolution.ts";
import {
  decodeBody,
  type DraftKind,
  type DraftStore,
  makeBodyReader,
  makeDraftStore,
} from "./bodies.ts";
import {
  type CertFs,
  type CertRunner,
  caFiles,
  certificateInfo,
  type NssDeps,
  NssError,
  nssInstall,
  nssUninstall,
} from "./certs.ts";
import { DECODE_LIMITS, decodeChain, parseDecodeSteps } from "./decode.ts";
import {
  compileProxyHosts,
  type MitmHandlers,
  type MitmImportDone,
  MITMDUMP_HINT,
  makeMitm,
  type MitmProcess,
  type MitmSpawner,
  MitmStartError,
  type PortProbe,
  type ProxyHosts,
  type ReplayUpstream,
} from "./mitm.ts";
import { requestOrigin } from "./origin.ts";
import {
  EXPORT_DETAILS,
  IMPORT_DETAILS,
  invalidHostPatternDetail,
  MISSING_DETAILS,
  mustBeDetail,
  noDefaultProxyDetail,
  NSS_DETAILS,
  PROXY_DETAILS,
  REPLAY_INPUT_DETAILS,
  sensitiveHeaderDetail,
} from "./refusals.ts";
import {
  type InspectorTimer,
  makeReplayService,
  REPLAY_LIMITS,
  type ReplayBodyEdit,
  type ReplayCarrier,
  type ReplayEdits,
  type ReplayService,
  replayStatusItem,
  realTimer,
} from "./replay.ts";
import {
  type BodyMeta,
  type BodySide,
  type FlowWriteResult,
  type HeaderPair,
  type InspectorStore,
  InspectorRefusal,
  type LinkKind,
  type LinkRecord,
  openInspectorStore,
  type ProxyOptions,
  type ProxyRecord,
  type RecordingRecord,
  type RequestRecord,
  type RequestSummary,
  type SearchFilter,
  STORE_LIMITS,
  type StorageStep,
  type StoreChange,
  type UpstreamAuth,
} from "./store.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

export const INSPECTOR_DEFAULTS = {
  listenHost: "127.0.0.1",
  listenPort: 8080,
  maxBodyBytes: 1 * MiB,
  maxDiskBytes: 512 * MiB,
  maxRequestsPerRecording: 50_000,
} as const;

const MIN_DISK_BYTES = 64 * MiB;
const MAX_BODY_BYTES = 16 * MiB;
const HEADER_VALUE_CHARS = 8 * KiB;
const HEADER_SIDE_CHARS = 32 * KiB;
const DEFAULT_PREVIEW_BYTES = 8192;
const MAX_PREVIEW_BYTES = 32768;
const DETAIL_PATH_CHARS = 8192;
const MAX_LISTED_RECORDINGS = 500;
const REFERENCE_DETAIL_CHARS = 4000;
// The SDK caps a result or snapshot at PLUGIN_LIMITS.maxPayloadBytes; leave room for its envelope.
const PAYLOAD_BYTES = 224 * KiB;
/** D36: each mitmdump holds roughly 80 MB of RSS. */
const MAX_RUNNING_PROXIES = 8;
/** Keeps list_proxies and the proxies snapshot inside one payload. */
const MAX_LIVE_PROXIES = 32;
const MAX_HOST_PATTERNS = 256;
const MAX_PATTERN_CHARS = 255;
const MAX_PATTERN_LIST_CHARS = 4 * KiB;
const MAX_NAME_CHARS = 64;
const MAX_TARGET_ID_CHARS = 128;
const MAX_EXPORT_REQUESTS = 500;
const INLINE_EXPORT_BYTES = 64 * KiB;
const MAX_EXPORT_BYTES = 32 * MiB;
const MAX_EXPORT_READ_BYTES = 128 * KiB;
const MAX_FORMATTED_HEADER_CHARS = 192 * KiB;
const MAX_NSS_DBS = 64;
const CONFDIR = "mitmproxy";
const MAX_RUNNING_IMPORTS = 2;
const MAX_KEPT_IMPORTS = 32;
const UPLOADS: DraftKind = {
  prefix: "upload-",
  maxBytes: 1024 * MiB,
  maxDrafts: 2,
  tooLargeDetail: IMPORT_DETAILS.uploadTooLarge,
  missingDetail: IMPORT_DETAILS.uploadMissing,
};
const EXPORT_CREATOR = { name: "T3 Request Inspector", version: "0.2.1" } as const;

export interface InspectorConfig {
  /** Default listen host for new proxies. */
  readonly listenHost: string;
  /** Where an `"auto"` port scan starts. */
  readonly listenPort: number;
  readonly maxBodyBytes: number;
  readonly maxDiskBytes: number;
  readonly maxRequestsPerRecording: number;
}

const numberSetting = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;

export function readInspectorConfig(config: Readonly<Record<string, unknown>>): InspectorConfig {
  return {
    listenHost:
      typeof config.listenHost === "string" && config.listenHost.trim() !== ""
        ? config.listenHost.trim()
        : INSPECTOR_DEFAULTS.listenHost,
    listenPort: numberSetting(config.listenPort, INSPECTOR_DEFAULTS.listenPort, 1, 65535),
    maxBodyBytes: numberSetting(
      config.maxBodyBytes,
      INSPECTOR_DEFAULTS.maxBodyBytes,
      0,
      MAX_BODY_BYTES,
    ),
    maxDiskBytes: numberSetting(
      config.maxDiskBytes,
      INSPECTOR_DEFAULTS.maxDiskBytes,
      MIN_DISK_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
    // The setting keeps its 0.1 key so saved values carry over.
    maxRequestsPerRecording: numberSetting(
      config.maxRequestsPerCapture,
      INSPECTOR_DEFAULTS.maxRequestsPerRecording,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export interface InspectorDeps {
  readonly addonSource: string;
  readonly spawner?: MitmSpawner;
  /** PATH searched for mitmdump. Defaults to the worker's PATH. */
  readonly searchPath?: string;
  readonly probePort?: PortProbe;
  readonly timer?: InspectorTimer;
  readonly now?: () => number;
  readonly materialize?: (name: string, contents: string) => Promise<string>;
  readonly reportStatus?: (state: PluginWorkerStatus, detail?: string) => void;
  readonly maxReplayHistory?: number;
  /** Caps requests per export below the default, for tests. */
  readonly maxExportRequests?: number;
  readonly onStorageStep?: (step: StorageStep) => void;
  /** Overrides config values, for tests that need a budget below the 64 MiB setting floor. */
  readonly configOverrides?: Partial<InspectorConfig>;
  /** NSS and certificate helpers; the defaults act on this machine. */
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly certFs?: CertFs;
  readonly certRun?: CertRunner;
}

interface ProxyEntry {
  readonly proxyId: number;
  readonly process: MitmProcess;
  readonly listenHost: string;
  readonly listenPort: number;
  /** What the process started with, to tell when an update needs a restart (D19). */
  readonly fingerprint: string;
  readonly live: { recordingId: number | undefined };
  /** Set before an intended stop, so the exit is not reported as a failure. */
  stopping: "stop" | "restart" | undefined;
  finished: Promise<void>;
}

type ProxyState =
  | { readonly state: "starting" }
  | { readonly state: "failed"; readonly detail: string };

type ImportState = "running" | "completed" | "failed";

/** One flow file being read into a recording. Kept in memory only, like the processes. */
interface ImportJob {
  readonly recordingId: number;
  readonly proxyId: number;
  readonly name: string;
  state: ImportState;
  imported: number;
  /** Flows of other kinds (TCP, UDP, DNS) the inspector does not store. */
  skipped: number;
  /** HTTP flows not stored: the storage budget or maxRequestsPerRecording was reached. */
  dropped: number;
  detail?: string;
  readonly finished: Promise<void>;
  readonly stop: () => Promise<void>;
  /** Ends a running import whose recording was deleted. */
  readonly cancel: () => void;
}

const importView = (job: ImportJob) => ({
  recordingId: String(job.recordingId),
  proxyId: String(job.proxyId),
  name: job.name,
  state: job.state,
  imported: job.imported,
  skipped: job.skipped,
  dropped: job.dropped,
  ...(job.detail === undefined ? {} : { detail: job.detail }),
});

interface Session {
  readonly store: InspectorStore;
  readonly drafts: DraftStore;
  readonly uploads: DraftStore;
  readonly readBody: ReturnType<typeof makeBodyReader>;
  readonly replay: ReplayService;
  readonly mitm: ReturnType<typeof makeMitm>;
  readonly config: InspectorConfig;
  readonly dataDir: string;
  readonly log: (message: string) => void;
}

type Input = Readonly<Record<string, unknown>>;

const objectInput = (input: unknown): Input =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Input) : {};

const isObject = (value: unknown): value is Input =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string) => new InspectorRefusal("invalid-input", message);

const optionalString = (input: Input, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(mustBeDetail(key, "a string"));
  return value;
};

const optionalInteger = (input: Input, key: string): number | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid(mustBeDetail(key, "an integer"));
  }
  return value;
};

const optionalBoolean = (input: Input, key: string): boolean | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${key} must be true or false.`);
  return value;
};

const optionalName = (input: Input, key: string, max = MAX_NAME_CHARS): string | undefined => {
  const value = optionalString(input, key)?.trim();
  if (value === undefined || value === "") return undefined;
  if (value.length > max) throw invalid(`${key} is at most ${max} characters.`);
  return value;
};

const ID_PATTERN = /^[1-9]\d{0,15}$/;

const parseId = (value: unknown, what: "request" | "recording" | "proxy"): number => {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !ID_PATTERN.test(text)) {
    throw new InspectorRefusal("not-found", MISSING_DETAILS[what]);
  }
  return Number(text);
};

const optionalId = (value: unknown, what: "recording" | "proxy") =>
  value === undefined || value === null ? undefined : parseId(value, what);

const parseEdits = (value: unknown): ReplayEdits | undefined => {
  if (value === undefined) return undefined;
  const edits = objectInput(value);
  const method = optionalString(edits, "method");
  const url = optionalString(edits, "url");
  let headers: Array<readonly [string, string]> | undefined;
  if (edits.headers !== undefined) {
    if (!Array.isArray(edits.headers)) throw invalid(REPLAY_INPUT_DETAILS.headersShape);
    headers = edits.headers.map((pair: unknown) => {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string"
      ) {
        throw invalid(REPLAY_INPUT_DETAILS.headerPairs);
      }
      return [pair[0], pair[1]] as const;
    });
  }
  let body: ReplayBodyEdit | undefined;
  if (edits.body !== undefined) {
    const raw = objectInput(edits.body);
    if (raw.kind === "inline" && typeof raw.base64 === "string") {
      body = { kind: "inline", base64: raw.base64 };
    } else if (raw.kind === "draft" && typeof raw.draftId === "string") {
      body = { kind: "draft", draftId: raw.draftId };
    } else {
      throw invalid(REPLAY_INPUT_DETAILS.bodyShape);
    }
  }
  return {
    ...(method === undefined ? {} : { method }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
};

const replayInput = (input: Input, ctx: OperationContext) => {
  const edits = parseEdits(input.edits);
  return {
    requestId: parseId(input.requestId, "request"),
    ...(edits === undefined ? {} : { edits }),
    ...(redactsFor(input, ctx) ? { credentials: "recorded-origin" as const } : {}),
  };
};

const parseStringList = (value: unknown, key: string, maxItems: number, maxChars: number) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalid(`${key} must be an array of at most ${maxItems} strings.`);
  }
  return value.map((item: unknown) => {
    if (typeof item !== "string" || item.length > maxChars) {
      throw invalid(`${key} must hold strings of at most ${maxChars} characters.`);
    }
    return item;
  });
};

const UPSTREAM_URL = /^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;

interface ParsedProxyOptions {
  readonly options: ProxyOptions;
  /** undefined keeps the stored credentials, null clears them. */
  readonly auth: UpstreamAuth | null | undefined;
}

const parseHostList = (value: unknown, key: string, base: ReadonlyArray<string>) => {
  const list = parseStringList(value, key, MAX_HOST_PATTERNS, MAX_PATTERN_CHARS);
  if (list === undefined) return base;
  const patterns = list.map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
  if (patterns.reduce((total, pattern) => total + pattern.length, 0) > MAX_PATTERN_LIST_CHARS) {
    throw invalid(`${key} holds at most ${MAX_PATTERN_LIST_CHARS} characters of patterns.`);
  }
  return patterns;
};

function parseMode(value: unknown): {
  mode: ProxyOptions["mode"];
  auth: ParsedProxyOptions["auth"];
} {
  if (!isObject(value))
    throw invalid('mode must be { "kind": "regular" | "socks5" | "upstream" }.');
  if (value.kind === "regular") return { mode: { kind: "regular" }, auth: null };
  if (value.kind === "socks5") {
    if (value.url !== undefined || (value.auth !== undefined && value.auth !== null)) {
      throw invalid(PROXY_DETAILS.upstreamWithSocks5);
    }
    return { mode: { kind: "socks5" }, auth: null };
  }
  if (value.kind !== "upstream") {
    throw invalid('mode.kind must be "regular", "socks5" or "upstream".');
  }
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const port = Number(UPSTREAM_URL.exec(url)?.[1] ?? 0);
  if (port < 1 || port > 65535) {
    throw invalid("mode.url must be http://host:port or https://host:port.");
  }
  let auth: ParsedProxyOptions["auth"];
  if (value.auth === null) auth = null;
  else if (value.auth !== undefined) {
    const raw = objectInput(value.auth);
    if (
      typeof raw.username !== "string" ||
      typeof raw.password !== "string" ||
      raw.username === "" ||
      raw.username.includes(":") ||
      raw.username.length > 256 ||
      raw.password.length > 256
    ) {
      throw invalid(
        "mode.auth must be { username, password }: a username without ':' and both at most 256 characters.",
      );
    }
    auth = { username: raw.username, password: raw.password };
  }
  return { mode: { kind: "upstream", url }, auth };
}

/** Merges `value` over `base`; every field is optional. */
function parseProxyOptions(value: unknown, base: ProxyOptions): ParsedProxyOptions {
  if (value === undefined) return { options: base, auth: undefined };
  if (!isObject(value)) throw invalid("options must be an object.");
  let listenHost = base.listenHost;
  if (value.listenHost !== undefined) {
    if (
      typeof value.listenHost !== "string" ||
      value.listenHost.trim() === "" ||
      value.listenHost.length > 255
    ) {
      throw invalid("listenHost must be a host name or address.");
    }
    listenHost = value.listenHost.trim();
  }
  let listenPort = base.listenPort;
  if (value.listenPort !== undefined) {
    const port = value.listenPort;
    if (
      port !== "auto" &&
      (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    ) {
      throw invalid('listenPort must be "auto" or a port from 1 to 65535.');
    }
    listenPort = port;
  }
  const parsedMode = value.mode === undefined ? undefined : parseMode(value.mode);
  const options: ProxyOptions = {
    listenHost,
    listenPort,
    mode: parsedMode?.mode ?? base.mode,
    passthroughHosts: parseHostList(
      value.passthroughHosts,
      "passthroughHosts",
      base.passthroughHosts,
    ),
    ignoredHosts: parseHostList(value.ignoredHosts, "ignoredHosts", base.ignoredHosts),
  };
  compiledHosts(options);
  return { options, auth: parsedMode?.auth };
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

/** Agents may listen on loopback or on a host the user already chose, never open a new one. */
const checkAgentListenHost = (
  ctx: OperationContext,
  host: string,
  userHosts: ReadonlyArray<string>,
) => {
  if (ctx.caller === "agent" && !LOOPBACK_HOST.test(host) && !userHosts.includes(host)) {
    throw invalid(PROXY_DETAILS.agentListenHost);
  }
};

function compiledHosts(options: ProxyOptions): ProxyHosts {
  const compiled = compileProxyHosts(options.passthroughHosts, options.ignoredHosts);
  if (!compiled.ok) throw invalid(invalidHostPatternDetail(compiled.pattern, compiled.reason));
  return compiled.hosts;
}

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

const restartFingerprint = (options: ProxyOptions, auth: UpstreamAuth | undefined) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        options.listenHost,
        options.listenPort,
        options.mode,
        options.mode.kind === "upstream" ? (auth ?? null) : null,
      ]),
    )
    .digest("hex");

/** The address a client on this machine dials for a proxy listening on `host`. */
const dialHost = (host: string) => {
  if (host === "" || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
};

export const summaryView = (summary: RequestSummary) => ({
  ...summary,
  id: String(summary.id),
  recordingId: String(summary.recordingId),
  proxyId: String(summary.proxyId),
});

export const recordingView = (recording: RecordingRecord) => ({
  ...recording,
  id: String(recording.id),
  proxyId: String(recording.proxyId),
});

/** Agents see credential header values only when they ask; the user's panel always sees them. */
const redactsFor = (raw: Input, ctx: OperationContext) =>
  ctx.caller === "agent" && raw.includeSensitiveHeaders !== true;

const headerText = (pairs: ReadonlyArray<HeaderPair>, redact = false): HeaderList =>
  pairs.map(([nameBytes, value]) => {
    const name = Buffer.from(nameBytes).toString("latin1");
    const text = Buffer.from(value).toString("latin1");
    return [name, redact ? redactHeaderValue(name, text) : text] as const;
  });

/** Ordered headers with each value cut at 8 KiB and the side cut at 32 KiB. */
export function shapeHeaders(
  pairs: ReadonlyArray<HeaderPair>,
  redact: boolean,
  sideChars = HEADER_SIDE_CHARS,
) {
  const headers: Array<[string, string]> = [];
  let truncated = false;
  let used = 0;
  for (const [name, value] of headerText(pairs, redact)) {
    let text = value;
    if (text.length > HEADER_VALUE_CHARS) {
      text = text.slice(0, HEADER_VALUE_CHARS);
      truncated = true;
    }
    if (used + name.length + text.length > sideChars) {
      truncated = true;
      break;
    }
    used += name.length + text.length;
    headers.push([name, text]);
  }
  return { headers, headersTruncated: truncated };
}

const TEXT_TYPE =
  /^\s*(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)|[^;]*\+(?:json|xml))/i;

const looksLikeText = (bytes: Buffer) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
};

/** Cuts at most 3 trailing bytes so a preview never ends inside a UTF-8 sequence. */
const utf8Prefix = (bytes: Buffer, limit: number) => {
  let end = Math.min(limit, bytes.byteLength);
  if (end < bytes.byteLength) {
    let back = 0;
    while (back < 3 && end - back > 0 && ((bytes[end - back] ?? 0) & 0xc0) === 0x80) back += 1;
    end -= back;
  }
  return bytes.subarray(0, end);
};

const decodedOrUndefined = (bytes: Buffer, contentEncoding: string | undefined) => {
  try {
    return decodeBody(bytes, contentEncoding);
  } catch {
    return undefined;
  }
};

function readBodyView(
  store: InspectorStore,
  requestId: number,
  side: BodySide,
  meta: BodyMeta,
  withPreview: boolean,
) {
  const base = {
    capturedBytes: meta.capturedBytes,
    ...(meta.declaredBytes === undefined ? {} : { declaredBytes: meta.declaredBytes }),
    truncated: meta.truncated,
    ...(meta.contentEncoding === undefined ? {} : { contentEncoding: meta.contentEncoding }),
  };
  const typed = meta.contentType === undefined ? undefined : TEXT_TYPE.test(meta.contentType);
  const raw =
    withPreview || typed === undefined ? store.readBody(requestId, side)?.bytes : undefined;
  if (raw === undefined) return { base: { ...base, isText: typed ?? false } };
  const decoded = decodedOrUndefined(raw, meta.contentEncoding);
  const isText = typed ?? (decoded !== undefined && looksLikeText(decoded.subarray(0, 4096)));
  if (!withPreview) return { base: { ...base, isText } };
  return {
    base: { ...base, isText },
    source: decoded ?? raw,
    decoded: decoded !== undefined,
    asText: isText && decoded !== undefined,
  };
}

const renderBodyView = (body: ReturnType<typeof readBodyView>, previewBytes: number) => {
  if (body.source === undefined) return body.base;
  const slice = body.asText
    ? utf8Prefix(body.source, previewBytes)
    : body.source.subarray(0, previewBytes);
  return {
    ...body.base,
    preview: {
      decoded: body.decoded,
      ...(body.asText ? { text: slice.toString("utf8") } : { base64: slice.toString("base64") }),
      bytes: slice.byteLength,
      totalBytes: body.source.byteLength,
      complete: slice.byteLength === body.source.byteLength,
    },
  };
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const tunnelFields = (summary: RequestSummary) => ({
  ...(summary.sni === undefined ? {} : { sni: summary.sni }),
  ...(summary.clientAddr === undefined ? {} : { clientAddr: summary.clientAddr }),
  ...(summary.endedAt === undefined ? {} : { endedAt: summary.endedAt }),
  ...(summary.bytesUp === undefined ? {} : { bytesUp: summary.bytesUp }),
  ...(summary.bytesDown === undefined ? {} : { bytesDown: summary.bytesDown }),
});

/**
 * Shrinks previews, then headers, then the path until the JSON fits `budgetBytes`:
 * escaping can grow control bytes in text sixfold.
 */
export function requestDetail(
  store: InspectorStore,
  record: RequestRecord,
  options: {
    readonly previewBytes: number;
    readonly bodies: "none" | "request" | "response" | "both";
    readonly redact?: boolean;
  },
  budgetBytes = PAYLOAD_BYTES,
) {
  const { summary } = record;
  const body = (side: BodySide, meta: BodyMeta | undefined) =>
    meta === undefined
      ? undefined
      : readBodyView(
          store,
          summary.id,
          side,
          meta,
          options.bodies === "both" || options.bodies === side,
        );
  const requestBody = body("request", record.requestBody);
  const responseBody = body("response", record.response?.body);
  const render = (previewBytes: number, headerChars: number, pathChars: number) => {
    const pathCut = record.path.length > pathChars;
    return {
      id: String(summary.id),
      recordingId: String(summary.recordingId),
      proxyId: String(summary.proxyId),
      startedAt: summary.startedAt,
      flowType: summary.flowType,
      method: summary.method,
      scheme: summary.scheme,
      host: summary.host,
      port: summary.port,
      authority: record.authority,
      path: pathCut ? record.path.slice(0, pathChars) : record.path,
      ...(pathCut ? { pathTruncated: true } : {}),
      httpVersion: record.httpVersion,
      ...(summary.replayOf === undefined ? {} : { replayOf: summary.replayOf }),
      ...(summary.error === undefined ? {} : { error: summary.error }),
      ...tunnelFields(summary),
      request: {
        ...shapeHeaders(record.requestHeaders, options.redact === true, headerChars),
        ...(requestBody === undefined ? {} : { body: renderBodyView(requestBody, previewBytes) }),
      },
      ...(record.response === undefined
        ? {}
        : {
            response: {
              status: record.response.status,
              ...(record.response.reason === undefined ? {} : { reason: record.response.reason }),
              httpVersion: record.response.httpVersion,
              ...shapeHeaders(record.response.headers, options.redact === true, headerChars),
              ...(responseBody === undefined
                ? {}
                : { body: renderBodyView(responseBody, previewBytes) }),
            },
          }),
    };
  };
  let previewBytes = options.previewBytes;
  let headerChars = HEADER_SIDE_CHARS;
  let pathChars = DETAIL_PATH_CHARS;
  for (;;) {
    const detail = render(previewBytes, headerChars, pathChars);
    if (jsonBytes(detail) <= budgetBytes) return detail;
    if (previewBytes > 0) previewBytes = Math.floor(previewBytes / 2);
    else if (headerChars > 0) headerChars = Math.floor(headerChars / 2);
    else if (pathChars > STORE_LIMITS.summaryPathChars) pathChars = STORE_LIMITS.summaryPathChars;
    else return detail;
  }
}

const FLOW_TYPES: ReadonlySet<string> = new Set(["http", "websocket", "tunnel", "other"]);

const parseFilter = (input: Input): SearchFilter => {
  const query = optionalString(input, "query");
  const method = optionalString(input, "method");
  const host = optionalString(input, "host");
  const status = optionalInteger(input, "status");
  const recordingId = optionalId(input.recordingId, "recording");
  const flowType = input.flowType;
  if (flowType !== undefined && (typeof flowType !== "string" || !FLOW_TYPES.has(flowType))) {
    throw invalid('flowType must be "http", "websocket", "tunnel" or "other".');
  }
  return {
    ...(query === undefined || query === "" ? {} : { query }),
    ...(method === undefined || method === "" ? {} : { method }),
    ...(host === undefined || host === "" ? {} : { host }),
    ...(status === undefined ? {} : { status }),
    ...(recordingId === undefined ? {} : { recordingId }),
    ...(flowType === undefined ? {} : { flowType: flowType as SearchFilter["flowType"] & string }),
  };
};

const matchesFilter = (summary: RequestSummary, filter: SearchFilter) => {
  if (filter.recordingId !== undefined && summary.recordingId !== filter.recordingId) return false;
  if (filter.proxyId !== undefined && summary.proxyId !== filter.proxyId) return false;
  if (filter.flowType !== undefined && summary.flowType !== filter.flowType) return false;
  if (filter.method !== undefined && summary.method !== filter.method.toUpperCase()) return false;
  if (filter.host !== undefined && summary.host !== filter.host.toLowerCase()) return false;
  if (filter.status !== undefined && summary.status !== filter.status) return false;
  if (filter.query !== undefined) {
    const query = filter.query.toLowerCase();
    if (!summary.path.toLowerCase().includes(query) && !summary.host.includes(query)) return false;
  }
  return true;
};

/** Collects store changes and flushes them once per microtask. */
function coalesce<T>(flush: (items: Array<T>) => void) {
  let pending: Array<T> | undefined;
  return (item: T) => {
    if (pending !== undefined) {
      pending.push(item);
      return;
    }
    pending = [item];
    queueMicrotask(() => {
      const items = pending ?? [];
      pending = undefined;
      flush(items);
    });
  };
}

const callerOf = (ctx: OperationContext): CallerContext => ({
  threadId: ctx.context.thread?.id ?? null,
  projectId: ctx.context.projectId,
  parentThreadId: ctx.context.thread?.parentThreadId ?? null,
  rootThreadId: ctx.context.thread?.rootThreadId ?? null,
});

const NO_CALLER: CallerContext = {
  threadId: null,
  projectId: null,
  parentThreadId: null,
  rootThreadId: null,
};

const EXPORT_FORMATS: ReadonlySet<string> = new Set<ExportFormat>([
  "har",
  "curl",
  "raw",
  "json",
  "fetch",
  "python",
]);
const EXPORT_EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  har: "har",
  curl: "sh",
  raw: "txt",
  json: "json",
  fetch: "js",
  python: "py",
};
const HEADER_FORMATS: ReadonlySet<string> = new Set<HeaderFormat>([
  "raw",
  "json",
  "curl",
  "cookie-header",
  "netscape",
  "js",
  "python",
]);
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const parseSide = (value: unknown): BodySide => {
  if (value !== "request" && value !== "response") {
    throw invalid('side must be "request" or "response".');
  }
  return value;
};

/** Drops step previews from the first step on until the decode result fits one payload. */
function fitDecodeResult(result: ReturnType<typeof decodeChain>) {
  const steps = result.steps.map((step) => ({ ...step }));
  for (const step of steps) {
    if (jsonBytes({ ...result, steps }) <= PAYLOAD_BYTES) break;
    if (step.text === undefined && step.base64 === undefined) continue;
    delete step.text;
    delete step.base64;
    step.truncated = true;
  }
  return { ...result, steps };
}

/** HAR and JSON show response content decoded, and JSON request bodies too; others send raw bytes. */
const decodesBody = (format: ExportFormat, side: BodySide) =>
  format === "json" || (format === "har" && side === "response");

/** Charges `budget` for the stored bytes and, when decoded, for the decoded bytes as well. */
export function exportBodyInput(
  bytes: Buffer,
  meta: BodyMeta,
  decode: boolean,
  budget: { left: number },
): ExportBody {
  const charge = (size: number) => {
    budget.left -= size;
    if (budget.left < 0) throw invalid(EXPORT_DETAILS.tooLarge);
  };
  charge(bytes.byteLength);
  const result = decode ? decodedOrUndefined(bytes, meta.contentEncoding) : undefined;
  // identity and no encoding hand back the stored buffer: nothing was decoded.
  const decoded = result === bytes ? undefined : result;
  if (decoded !== undefined) charge(decoded.byteLength);
  return {
    bytes,
    truncated: meta.truncated,
    declaredBytes: meta.declaredBytes,
    contentType: meta.contentType,
    contentEncoding: meta.contentEncoding,
    ...(decoded === undefined ? {} : { decoded }),
  };
}

/** Cuts formatted headers until the JSON result fits one payload. */
export function fitFormattedHeaders(text: string) {
  if (text.length <= MAX_FORMATTED_HEADER_CHARS && jsonBytes({ text }) <= PAYLOAD_BYTES) {
    return { text };
  }
  let cut = Math.min(text.length, MAX_FORMATTED_HEADER_CHARS);
  for (;;) {
    const result = { text: text.slice(0, cut), truncated: true };
    const size = jsonBytes(result);
    if (size <= PAYLOAD_BYTES) return result;
    cut = Math.floor((cut * PAYLOAD_BYTES) / size) - 1;
  }
}

export function createInspectorBackend(deps: InspectorDeps): PluginBackendDefinition {
  const timer = deps.timer ?? realTimer;
  const now = deps.now ?? Date.now;
  const report = deps.reportStatus ?? reportStatus;
  let session: Session | undefined;
  const running = new Map<number, ProxyEntry>();
  const imports = new Map<number, ImportJob>();
  /** import_flows calls past the slot check whose job is not in `imports` yet. */
  const startingImports = new Map<Promise<unknown>, number>();
  const states = new Map<number, ProxyState>();
  const runtimeListeners = new Set<(proxyId: number) => void>();
  let missingReported = false;
  let control: Promise<unknown> = Promise.resolve();

  const nssDeps = (): NssDeps => ({
    // oxlint-disable-next-line t3code/no-global-process-runtime -- The packed backend has no Effect runtime.
    platform: deps.platform ?? process.platform,
    home: deps.home ?? NodeOS.homedir(),
    ...(deps.certFs === undefined ? {} : { fs: deps.certFs }),
    ...(deps.certRun === undefined ? {} : { run: deps.certRun }),
  });

  /** Proxy lifecycle changes run one at a time, so port exclusion and the D36 cap see settled state. */
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = control.then(fn);
    control = next.catch(() => undefined);
    return next;
  };

  const current = (): Session => {
    if (session === undefined) throw new Error("The inspector has not started.");
    return session;
  };

  const notify = (proxyId: number) => {
    for (const listener of runtimeListeners) listener(proxyId);
  };

  const setState = (proxyId: number, state: ProxyState | undefined) => {
    if (state === undefined) states.delete(proxyId);
    else states.set(proxyId, state);
    notify(proxyId);
  };

  const links = (store: InspectorStore): Array<ProxyLink> =>
    store.listLinks().map((link) => ({
      kind: link.kind,
      id: link.targetId,
      proxyId: String(link.proxyId),
      linkedAt: link.linkedAt,
    }));

  const proxyView = (
    store: InspectorStore,
    proxy: ProxyRecord,
    allLinks: ReadonlyArray<ProxyLink>,
    caller: CallerContext | undefined,
  ) => {
    const entry = running.get(proxy.id);
    const state = states.get(proxy.id);
    const recording = store.openRecording(proxy.id);
    const { options } = proxy;
    const id = String(proxy.id);
    return {
      kind: "proxy" as const,
      id,
      name: proxy.name,
      state: entry !== undefined ? ("running" as const) : (state?.state ?? ("stopped" as const)),
      ...(entry === undefined && state?.state === "failed" ? { stateDetail: state.detail } : {}),
      listen: entry === undefined ? null : { host: entry.listenHost, port: entry.listenPort },
      requested: { host: options.listenHost, port: options.listenPort },
      mode:
        options.mode.kind === "upstream"
          ? { kind: "upstream" as const, url: options.mode.url, hasAuth: proxy.hasUpstreamAuth }
          : { kind: options.mode.kind },
      passthroughHosts: options.passthroughHosts,
      ignoredHosts: options.ignoredHosts,
      recording:
        recording === undefined
          ? null
          : {
              id: String(recording.id),
              ...(recording.name === undefined ? {} : { name: recording.name }),
              startedAt: recording.startedAt,
              droppedFlows: recording.droppedFlows,
            },
      restartRequired:
        entry !== undefined &&
        entry.fingerprint !== restartFingerprint(options, store.upstreamAuth(proxy.id)),
      links: allLinks
        .filter((link) => link.proxyId === id)
        .map((link) => ({ kind: link.kind, id: link.id })),
      callerLink: caller === undefined ? null : callerLink(id, allLinks, caller),
      deletedAt: proxy.deletedAt ?? null,
    };
  };

  /** Live proxies first, then deleted ones newest first, as many as fit `budget`. */
  const proxyViews = (store: InspectorStore, caller: CallerContext | undefined, budget: number) => {
    const allLinks = links(store);
    const proxies = store.listProxies();
    const ordered = [
      ...proxies.filter((proxy) => proxy.deletedAt === undefined),
      ...proxies.filter((proxy) => proxy.deletedAt !== undefined).toReversed(),
    ];
    const views: Array<ReturnType<typeof proxyView>> = [];
    let used = 0;
    for (const proxy of ordered) {
      const view = proxyView(store, proxy, allLinks, caller);
      used += jsonBytes(view) + 1;
      if (used > budget) break;
      views.push(view);
    }
    return views;
  };

  const viewOf = (proxyId: number, caller?: CallerContext) => {
    const { store } = current();
    const proxy = store.getProxy(proxyId);
    if (proxy === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.proxy);
    return proxyView(store, proxy, links(store), caller);
  };

  const statusItem = (store: InspectorStore) => ({
    kind: "status" as const,
    storageBlocked: store.status().storageBlocked,
  });

  const resolveProxyId = (input: Input, ctx: OperationContext | undefined): number => {
    const { store } = current();
    const explicit = optionalId(input.proxyId, "proxy");
    const proxies = store.listProxies();
    const resolved = resolveProxy({
      explicit: explicit === undefined ? undefined : String(explicit),
      links: links(store),
      context: ctx === undefined ? NO_CALLER : callerOf(ctx),
      proxies: proxies.map((proxy) => ({ id: String(proxy.id), deletedAt: proxy.deletedAt })),
    });
    if (!("refusal" in resolved)) return Number(resolved.proxyId);
    if (resolved.refusal === "not-found") {
      throw new InspectorRefusal("not-found", MISSING_DETAILS.proxy);
    }
    const names = new Map(proxies.map((proxy) => [String(proxy.id), proxy.name]));
    throw invalid(
      noDefaultProxyDetail(
        resolved.candidates.map((candidate) => ({
          ...candidate,
          name: names.get(candidate.proxyId) ?? "",
        })),
      ),
    );
  };

  const liveProxy = (proxyId: number): ProxyRecord => {
    const proxy = current().store.getProxy(proxyId);
    if (proxy === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.proxy);
    if (proxy.deletedAt !== undefined)
      throw new InspectorRefusal("conflict", PROXY_DETAILS.deleted);
    return proxy;
  };

  const startFailure = (error: unknown): never => {
    if (error instanceof MitmStartError) {
      if (error.reason === "missing-prerequisite") {
        missingReported = true;
        report("missing-prerequisite", MITMDUMP_HINT);
      }
      throw new InspectorRefusal("conflict", error.message);
    }
    throw error;
  };

  const markRunning = () => {
    if (!missingReported) return;
    missingReported = false;
    report("running");
  };

  const withStartupDeadline = <T>(ready: Promise<T>, stop: () => Promise<void>) =>
    new Promise<T>((resolve, reject) => {
      const cancel = timer.after(REPLAY_LIMITS.startupMs, () => {
        void stop();
        reject(new MitmStartError("not-started", "mitmdump did not start within 10 s."));
      });
      ready.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    });

  const flowHandlers = (live: ProxyEntry["live"]): MitmHandlers => {
    const store = async (write: (recordingId: number) => Promise<FlowWriteResult>) => {
      const { store: inspectorStore, config, log } = current();
      const recordingId = live.recordingId;
      if (recordingId === undefined) return;
      const record = inspectorStore.getRecording(recordingId);
      if (record !== undefined && record.requestCount >= config.maxRequestsPerRecording) {
        await inspectorStore.exclusive((lane) => lane.noteDroppedFlow(recordingId));
        return;
      }
      try {
        await write(recordingId);
      } catch {
        log("Storing a captured flow failed; it was dropped.");
        await inspectorStore.exclusive((lane) => lane.noteDroppedFlow(recordingId));
      }
    };
    return {
      onFlow: (flow) =>
        store((recordingId) => current().store.insertFlow({ ...flow, recordingId })),
      onTunnel: (tunnel) =>
        store((recordingId) => current().store.insertTunnel({ ...tunnel, recordingId })),
      onReplayResult: (result) => current().replay.onResult(result),
    };
  };

  const closeRecording = async (proxyId: number, recordingId: number) => {
    const { store, log } = current();
    await store
      .exclusive((lane) => lane.stopRecording(recordingId, now()))
      .catch(() => log("Recording the end of a recording failed."));
    notify(proxyId);
  };

  /** The file a path or upload import reads, its default name, and what to delete afterwards. */
  const importSource = (raw: Input) => {
    const path = optionalString(raw, "path");
    const uploadId = optionalString(raw, "uploadId");
    if ((path === undefined) === (uploadId === undefined)) throw invalid(IMPORT_DETAILS.source);
    if (uploadId !== undefined) {
      const { uploads, store } = current();
      if (uploads.path(uploadId) === undefined) {
        throw new InspectorRefusal("not-found", IMPORT_DETAILS.uploadMissing);
      }
      return {
        name: "Uploaded flows",
        take: () => {
          const file = uploads.take(uploadId) as string;
          const cleanup = () => {
            NodeFS.rmSync(file, { force: true });
            store.exclusive((lane) => lane.noteFileWrite()).catch(() => undefined);
          };
          return { file, cleanup };
        },
      };
    }
    const home = deps.home ?? NodeOS.homedir();
    const trimmed = (path as string).trim();
    const file =
      trimmed === "~" || trimmed.startsWith("~/") ? NodePath.join(home, trimmed.slice(1)) : trimmed;
    if (!NodePath.isAbsolute(file)) throw invalid(IMPORT_DETAILS.relativePath);
    try {
      if (!NodeFS.statSync(file).isFile()) throw new Error("Not a file.");
      NodeFS.accessSync(file, NodeFS.constants.R_OK);
    } catch {
      throw new InspectorRefusal("not-found", IMPORT_DETAILS.notAFile);
    }
    return { name: NodePath.basename(file), take: () => ({ file, cleanup: () => undefined }) };
  };

  /** Starts mitmdump on `file` and resolves once it runs; the import then goes on by itself. */
  const startImport = async (
    proxyId: number,
    name: string,
    file: string,
    cleanup: () => void,
  ): Promise<ImportJob> => {
    const { store, mitm, config, log } = current();
    const recording = await store.exclusive((lane) =>
      lane.addImportedRecording({ proxyId, createdAt: now(), name }),
    );
    const recordingId = recording.id;
    let reportDone: (done: MitmImportDone | "deleted") => void = () => undefined;
    const done = new Promise<MitmImportDone | "deleted">((resolve) => {
      reportDone = resolve;
    });
    let settle: () => void = () => undefined;
    const job: ImportJob = {
      recordingId,
      proxyId,
      name,
      state: "running",
      imported: 0,
      skipped: 0,
      dropped: 0,
      finished: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      stop: async () => {
        await started.stop();
        await job.finished;
      },
      cancel: () => reportDone("deleted"),
    };
    const started = mitm.start(
      { kind: "import", path: file },
      {
        onFlow: async (flow) => {
          if (job.imported >= config.maxRequestsPerRecording) {
            job.dropped += 1;
            await store.exclusive((lane) => lane.noteDroppedFlow(recordingId));
            return;
          }
          const result = await store
            .insertFlow({ ...flow, recordingId })
            .catch(async (): Promise<FlowWriteResult> => {
              // The store counts its own refusals; a thrown write must be counted here.
              await store
                .exclusive((lane) => lane.noteDroppedFlow(recordingId))
                .catch(() => undefined);
              return { ok: false, reason: "storage-full" };
            });
          if (result.ok) job.imported += 1;
          else if (result.reason === "not-found") reportDone("deleted");
          else job.dropped += 1;
        },
        onTunnel: async () => undefined,
        onReplayResult: async () => undefined,
        onImportDone: async (result) => reportDone(result),
      },
    );
    let process: MitmProcess;
    try {
      process = await withStartupDeadline(started.ready, started.stop);
    } catch (error) {
      await store.exclusive((lane) => lane.deleteRecording(recordingId)).catch(() => undefined);
      settle();
      return startFailure(error);
    }
    markRunning();

    const finish = async () => {
      const outcome = await Promise.race([done, process.exited.then(() => "exited" as const)]);
      await started.stop();
      if (outcome === "deleted") {
        job.detail = IMPORT_DETAILS.deleted;
      } else {
        if (outcome !== "exited") job.skipped = outcome.skipped;
        const error = outcome === "exited" ? IMPORT_DETAILS.exited : outcome.error;
        const detail = error ?? (job.imported === 0 ? IMPORT_DETAILS.noFlows : undefined);
        if (detail !== undefined) job.detail = detail;
        await store
          .exclusive((lane) =>
            job.imported === 0
              ? lane.deleteRecording(recordingId)
              : void lane.finishImportedRecording(recordingId),
          )
          .catch(() => log("Closing an imported recording failed."));
      }
      job.state = job.detail === undefined ? "completed" : "failed";
    };
    void finish()
      .catch(async () => {
        job.state = "failed";
        job.detail ??= IMPORT_DETAILS.exited;
        await store
          .exclusive((lane) => void lane.finishImportedRecording(recordingId))
          .catch(() => undefined);
      })
      .finally(() => {
        cleanup();
        settle();
      });

    imports.set(recordingId, job);
    for (const [id, kept] of imports) {
      if (imports.size <= MAX_KEPT_IMPORTS) break;
      if (kept.state !== "running") imports.delete(id);
    }
    return job;
  };

  const onProxyClosed = async (entry: ProxyEntry) => {
    // Before any await, so a start_proxy that runs meanwhile spawns instead of returning this.
    if (running.get(entry.proxyId) === entry) running.delete(entry.proxyId);
    const { replay } = current();
    await replay.interruptChannel(entry.process);
    const recordingId = entry.live.recordingId;
    if (entry.stopping !== "restart" && recordingId !== undefined) {
      entry.live.recordingId = undefined;
      await closeRecording(entry.proxyId, recordingId);
    }
    setState(
      entry.proxyId,
      entry.stopping === undefined ? { state: "failed", detail: "mitmdump exited." } : undefined,
    );
  };

  /** Starts `proxyId` unless it runs. `recordingId` reopens a recording kept across a restart. */
  const startProxyLocked = async (proxyId: number, recordingId?: number): Promise<ProxyEntry> => {
    const existing = running.get(proxyId);
    if (existing !== undefined) return existing;
    const { store, mitm, config } = current();
    const proxy = liveProxy(proxyId);
    if (running.size >= MAX_RUNNING_PROXIES) {
      throw new InspectorRefusal("conflict", PROXY_DETAILS.limit);
    }
    const hosts = compiledHosts(proxy.options);
    const auth = store.upstreamAuth(proxyId);
    const live: ProxyEntry["live"] = { recordingId };
    setState(proxyId, { state: "starting" });
    const start = mitm.start(
      {
        kind: "capture",
        proxy: {
          listenHost: proxy.options.listenHost,
          listenPort: proxy.options.listenPort,
          autoPortStart: config.listenPort,
          excludePorts: [...running.values()].map((entry) => entry.listenPort),
          mode: proxy.options.mode,
          upstreamAuth: auth ?? null,
          hosts,
          recording: recordingId !== undefined,
        },
      },
      flowHandlers(live),
    );
    let started: MitmProcess;
    try {
      started = await withStartupDeadline(start.ready, start.stop);
    } catch (error) {
      setState(proxyId, {
        state: "failed",
        detail: error instanceof Error ? error.message.slice(0, 512) : "mitmdump did not start.",
      });
      return startFailure(error);
    }
    markRunning();
    const entry: ProxyEntry = {
      proxyId,
      process: started,
      listenHost: proxy.options.listenHost,
      listenPort: started.listenPort ?? 0,
      fingerprint: restartFingerprint(proxy.options, auth),
      live,
      stopping: undefined,
      finished: Promise.resolve(),
    };
    entry.finished = started.closed.then(() => onProxyClosed(entry));
    running.set(proxyId, entry);
    setState(proxyId, undefined);
    return entry;
  };

  const stopEntry = async (entry: ProxyEntry, how: "stop" | "restart") => {
    entry.stopping = how;
    await entry.process.stop();
    await entry.finished;
  };

  const restartLocked = async (entry: ProxyEntry) => {
    const recordingId = entry.live.recordingId;
    await stopEntry(entry, "restart");
    try {
      return await startProxyLocked(entry.proxyId, recordingId);
    } catch (error) {
      if (recordingId !== undefined) await closeRecording(entry.proxyId, recordingId);
      throw error;
    }
  };

  const endpoint = (entry: ProxyEntry) => {
    const mode = current().store.getProxy(entry.proxyId)?.options.mode.kind;
    const proxyUrl = `${mode === "socks5" ? "socks5" : "http"}://${dialHost(entry.listenHost)}:${entry.listenPort}`;
    return {
      proxyId: String(entry.proxyId),
      listenHost: entry.listenHost,
      listenPort: entry.listenPort,
      proxyUrl,
      env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl },
    };
  };

  const startTransient = (upstream: ReplayUpstream | undefined) => {
    const { mitm, log } = current();
    const start = mitm.start(
      { kind: "replay", ...(upstream === undefined ? {} : { upstream }) },
      {
        onFlow: async () => undefined,
        onTunnel: async () => undefined,
        onReplayResult: (result) => current().replay.onResult(result),
      },
    );
    return {
      ready: start.ready.then(
        (started) => {
          markRunning();
          return started;
        },
        (error: unknown) => {
          if (error instanceof MitmStartError && error.reason === "missing-prerequisite") {
            missingReported = true;
            report("missing-prerequisite", MITMDUMP_HINT);
          }
          log("The replay mitmdump did not start.");
          throw error;
        },
      ),
      stop: start.stop,
    };
  };

  /** D35: the source proxy's process when it runs, else a replay-only one with its egress. */
  const carrierFor = (proxyId: number | undefined): ReplayCarrier => {
    const entry = proxyId === undefined ? undefined : running.get(proxyId);
    if (entry !== undefined && entry.process.isOpen()) {
      return { kind: "running", channel: entry.process };
    }
    const { store } = current();
    const mode = proxyId === undefined ? undefined : store.getProxy(proxyId)?.options.mode;
    if (proxyId !== undefined && mode?.kind === "upstream") {
      const upstream = { url: mode.url, auth: store.upstreamAuth(proxyId) ?? null };
      return {
        kind: "transient",
        key: `upstream:${proxyId}:${mode.url}`,
        start: () => startTransient(upstream),
      };
    }
    return { kind: "transient", key: "direct", start: () => startTransient(undefined) };
  };

  /** mitmdump writes its CA into the confdir at startup, so one short start creates it. */
  const ensureCa = async () => {
    const { dataDir } = current();
    const confdir = NodePath.join(dataDir, CONFDIR);
    if (caFiles(confdir, deps.certFs).exists) return;
    const carrier = startTransient(undefined);
    try {
      await withStartupDeadline(carrier.ready, carrier.stop).catch(startFailure);
    } finally {
      await carrier.stop();
    }
  };

  const nssFailure = (error: unknown): never => {
    if (error instanceof NssError) {
      throw new InspectorRefusal(
        "conflict",
        error.reason === "nss-unsupported" ? NSS_DETAILS.unsupported : NSS_DETAILS.certutilMissing,
      );
    }
    throw error;
  };

  const parseTarget = async (
    value: unknown,
    ctx: OperationContext,
    validate: boolean,
  ): Promise<{ readonly kind: LinkKind; readonly id: string }> => {
    if (value === "thread") {
      const id = ctx.context.thread?.id;
      if (id === undefined) throw invalid(PROXY_DETAILS.noCallerThread);
      return { kind: "thread", id };
    }
    if (value === "project") {
      const id = ctx.context.projectId;
      if (id === null) throw invalid(PROXY_DETAILS.noCallerProject);
      return { kind: "project", id };
    }
    const raw = objectInput(value);
    const keys = Object.keys(raw);
    const kind = keys.length === 1 && keys[0] === "threadId" ? "thread" : "project";
    const id = kind === "thread" ? raw.threadId : raw.projectId;
    if (
      keys.length !== 1 ||
      (keys[0] !== "threadId" && keys[0] !== "projectId") ||
      typeof id !== "string" ||
      id === "" ||
      id.length > MAX_TARGET_ID_CHARS
    ) {
      throw invalid('target must be "thread", "project", { "threadId" } or { "projectId" }.');
    }
    if (validate) {
      const resolved = await ctx.host.resolveContext(
        kind === "thread" ? { threadId: id } : { projectId: id },
      );
      if (resolved === null) throw new InspectorRefusal("not-found", MISSING_DETAILS.target);
    }
    return { kind, id };
  };

  const defaultLink = (ctx: OperationContext): "thread" | "project" | "none" =>
    ctx.context.thread !== null ? "thread" : ctx.context.projectId !== null ? "project" : "none";

  const linkRecord = (proxyId: number, target: { kind: LinkKind; id: string }): LinkRecord => ({
    kind: target.kind,
    targetId: target.id,
    proxyId,
    linkedAt: now(),
  });

  const exportEntry = (
    store: InspectorStore,
    record: RequestRecord,
    format: ExportFormat,
    withBodies: boolean,
    budget: { left: number },
    redact: boolean,
  ): ExportEntry => {
    const { summary } = record;
    const response = record.response;
    const exportBody = (side: BodySide, meta: BodyMeta | undefined) => {
      if (meta === undefined) return undefined;
      const stored = store.readBody(summary.id, side);
      if (stored === undefined) return undefined;
      return exportBodyInput(stored.bytes, meta, decodesBody(format, side), budget);
    };
    return {
      id: String(summary.id),
      flowType: summary.flowType,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      request: {
        method: summary.method,
        scheme: summary.scheme,
        host: summary.host,
        port: summary.port,
        authority: record.authority,
        path: record.path,
        httpVersion: record.httpVersion,
        headers: headerText(record.requestHeaders, redact),
        body: withBodies ? exportBody("request", record.requestBody) : undefined,
      },
      response:
        response === undefined
          ? undefined
          : {
              status: response.status,
              reason: response.reason,
              httpVersion: response.httpVersion,
              headers: headerText(response.headers, redact),
              body: withBodies ? exportBody("response", response.body) : undefined,
            },
      error: summary.error,
      sni: summary.sni,
      clientAddr: summary.clientAddr,
      bytesUp: summary.bytesUp,
      bytesDown: summary.bytesDown,
    };
  };

  /** Search scope per D17: an explicit proxy or recording, all proxies, or the resolved proxy. */
  const scopedFilter = (raw: Input, ctx: OperationContext | undefined) => {
    const filter = parseFilter(raw);
    const explicit = raw.proxyId !== undefined && raw.proxyId !== null;
    if (!explicit && (raw.allProxies === true || filter.recordingId !== undefined)) {
      return { filter, proxyId: null };
    }
    const proxyId = resolveProxyId(raw, ctx);
    return { filter: { ...filter, proxyId }, proxyId: String(proxyId) };
  };

  const subscribeRequests = (params: unknown, emit: TopicEmitter) => {
    const { store } = current();
    const raw = objectInput(params);
    // Subscriptions carry no caller context (D14): no proxyId means every proxy.
    const proxyId = optionalId(raw.proxyId, "proxy");
    const recordingId = optionalId(raw.recordingId, "recording");
    const filter: SearchFilter = {
      ...parseFilter(objectInput(raw.filter)),
      ...(recordingId === undefined ? {} : { recordingId }),
      ...(proxyId === undefined || raw.allProxies === true ? {} : { proxyId }),
    };
    const page = store.search(filter, {
      limit: STORE_LIMITS.maxSearchLimit,
      maxBytes: PAYLOAD_BYTES,
    });
    emit.snapshot({
      items: page.items.map(summaryView),
      revision: page.revision,
      cursor: page.cursor,
    });
    const push = coalesce<StoreChange>((changes) => {
      const items = new Map<number, unknown>();
      for (const change of changes) {
        if (change.type === "request" && matchesFilter(change.summary, filter)) {
          items.set(change.summary.id, summaryView(change.summary));
        } else if (
          change.type === "request-removed" &&
          (filter.recordingId === undefined || filter.recordingId === change.recordingId) &&
          (filter.proxyId === undefined || filter.proxyId === change.proxyId)
        ) {
          items.set(change.id, {
            kind: "request",
            id: String(change.id),
            seq: change.seq,
            removed: true,
          });
        }
      }
      if (items.size > 0) emit.batch([...items.values()], String(store.currentSeq()));
    });
    return store.onChange((change) => {
      if (change.type === "request" || change.type === "request-removed") push(change);
    });
  };

  const subscribeProxies = (_params: unknown, emit: TopicEmitter) => {
    const { store } = current();
    emit.snapshot({
      items: [...proxyViews(store, undefined, PAYLOAD_BYTES - 1024), statusItem(store)],
      revision: String(store.currentSeq()),
      cursor: null,
    });
    type Change = StoreChange | { readonly type: "runtime"; readonly proxyId: number };
    const push = coalesce<Change>((changes) => {
      const proxyIds = new Set<number>();
      const replays = new Map<string, unknown>();
      let status = false;
      for (const change of changes) {
        switch (change.type) {
          case "replay":
            replays.set(change.replay.replayId, replayStatusItem(change.replay));
            break;
          case "status":
            status = true;
            break;
          case "runtime":
          case "recording-removed":
            proxyIds.add(change.proxyId);
            break;
          case "proxy":
            proxyIds.add(change.proxy.id);
            break;
          case "recording":
            proxyIds.add(change.recording.proxyId);
            break;
          case "link":
            proxyIds.add(change.link.proxyId);
            break;
          case "link-removed":
            proxyIds.add(change.proxyId);
            break;
          default:
            break;
        }
      }
      const allLinks = links(store);
      const items: Array<unknown> = [];
      for (const proxyId of proxyIds) {
        const proxy = store.getProxy(proxyId);
        if (proxy !== undefined) items.push(proxyView(store, proxy, allLinks, undefined));
      }
      if (status) items.push(statusItem(store));
      items.push(...replays.values());
      if (items.length > 0) emit.batch(items, String(store.currentSeq()));
    });
    const onRuntime = (proxyId: number) => push({ type: "runtime", proxyId });
    runtimeListeners.add(onRuntime);
    const offStore = store.onChange((change) => {
      if (change.type !== "request" && change.type !== "request-removed") push(change);
    });
    return () => {
      runtimeListeners.delete(onRuntime);
      offStore();
    };
  };

  const operations: PluginBackendDefinition["operations"] = {
    list_proxies: async (_input, ctx) => {
      const { store } = current();
      const caller = callerOf(ctx);
      const resolved = resolveProxy({
        links: links(store),
        context: caller,
        proxies: store
          .listProxies()
          .map((proxy) => ({ id: String(proxy.id), deletedAt: proxy.deletedAt })),
      });
      return {
        proxies: proxyViews(store, caller, PAYLOAD_BYTES - 2048),
        caller,
        defaultProxyId: "refusal" in resolved ? null : resolved.proxyId,
      };
    },
    create_proxy: async (input, ctx) => {
      const { store, config } = current();
      const raw = objectInput(input);
      const name = optionalName(raw, "name");
      const { options, auth } = parseProxyOptions(raw.options, {
        listenHost: config.listenHost,
        listenPort: "auto",
        mode: { kind: "regular" },
        passthroughHosts: [],
        ignoredHosts: [],
      });
      checkAgentListenHost(ctx, options.listenHost, [config.listenHost]);
      const link = raw.link ?? defaultLink(ctx);
      if (link !== "thread" && link !== "project" && link !== "none") {
        throw invalid('link must be "thread", "project" or "none".');
      }
      const target = link === "none" ? undefined : await parseTarget(link, ctx, false);
      const proxies = store.listProxies();
      if (proxies.filter((proxy) => proxy.deletedAt === undefined).length >= MAX_LIVE_PROXIES) {
        throw new InspectorRefusal("conflict", PROXY_DETAILS.tooMany);
      }
      const created = await store.exclusive((lane) => {
        const proxy = lane.createProxy({
          name: name ?? `Proxy ${proxies.length + 1}`,
          createdAt: now(),
          options,
          ...(auth ? { upstreamAuth: auth } : {}),
        });
        if (target !== undefined) lane.link(linkRecord(proxy.id, target));
        return proxy;
      });
      return viewOf(created.id, callerOf(ctx));
    },
    update_proxy: async (input, ctx) =>
      serialized(async () => {
        const { store, config } = current();
        const raw = objectInput(input);
        const proxyId = parseId(raw.proxyId, "proxy");
        const proxy = liveProxy(proxyId);
        const name = optionalName(raw, "name");
        const restart = optionalBoolean(raw, "restart") ?? false;
        const { options, auth } = parseProxyOptions(raw.options ?? {}, proxy.options);
        checkAgentListenHost(ctx, options.listenHost, [
          config.listenHost,
          proxy.options.listenHost,
        ]);
        // Credentials belong to one upstream: a new url drops them unless auth comes with it.
        const sameUpstream =
          options.mode.kind === "upstream" &&
          proxy.options.mode.kind === "upstream" &&
          options.mode.url === proxy.options.mode.url;
        const requested = auth === undefined && !sameUpstream ? null : auth;
        const upstreamAuth =
          options.mode.kind !== "upstream"
            ? proxy.hasUpstreamAuth
              ? null
              : undefined
            : requested === null && !proxy.hasUpstreamAuth
              ? undefined
              : requested;
        let entry = running.get(proxyId);
        // Applied before the store write, so a refused change stays unsaved and a retry resends it.
        if (
          entry !== undefined &&
          (!sameList(options.passthroughHosts, proxy.options.passthroughHosts) ||
            !sameList(options.ignoredHosts, proxy.options.ignoredHosts))
        ) {
          await entry.process.setHosts(compiledHosts(options));
        }
        await store.exclusive((lane) =>
          lane.updateProxy(proxyId, {
            options,
            ...(name === undefined ? {} : { name }),
            ...(upstreamAuth === undefined ? {} : { upstreamAuth }),
          }),
        );
        if (entry !== undefined && restart) entry = await restartLocked(entry);
        const view = viewOf(proxyId, callerOf(ctx));
        return { proxy: view, restartRequired: view.restartRequired };
      }),
    delete_proxy: async (input) =>
      serialized(async () => {
        const { store } = current();
        const proxyId = parseId(objectInput(input).proxyId, "proxy");
        if (running.has(proxyId)) throw new InspectorRefusal("conflict", PROXY_DETAILS.running);
        if (
          [...startingImports.values()].includes(proxyId) ||
          [...imports.values()].some((job) => job.proxyId === proxyId && job.state === "running")
        ) {
          throw new InspectorRefusal("conflict", IMPORT_DETAILS.proxyBusy);
        }
        const deleted = await store.exclusive((lane) => lane.deleteProxy(proxyId, now()));
        return { proxyId: String(proxyId), deletedAt: deleted.deletedAt ?? now() };
      }),
    start_proxy: async (input, ctx) => {
      const proxyId = resolveProxyId(objectInput(input), ctx);
      return serialized(async () => endpoint(await startProxyLocked(proxyId)));
    },
    stop_proxy: async (input, ctx) => {
      const proxyId = resolveProxyId(objectInput(input), ctx);
      return serialized(async () => {
        const entry = running.get(proxyId);
        if (entry === undefined)
          return { proxyId: String(proxyId), wasRunning: false, recordingId: null };
        const recordingId = entry.live.recordingId;
        await stopEntry(entry, "stop");
        return {
          proxyId: String(proxyId),
          wasRunning: true,
          recordingId: recordingId === undefined ? null : String(recordingId),
        };
      });
    },
    link_proxy: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const proxyId = parseId(raw.proxyId, "proxy");
      liveProxy(proxyId);
      const target = await parseTarget(raw.target, ctx, true);
      await store.exclusive((lane) => lane.link(linkRecord(proxyId, target)));
      return { target };
    },
    unlink_proxy: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      // A deleted proxy's links are already gone, so any well-formed id is accepted.
      const proxyId = optionalId(raw.proxyId, "proxy");
      // Unlinking needs no host check, so a link to a deleted thread can still be removed.
      const target = await parseTarget(raw.target, ctx, false);
      const removed = await store.exclusive((lane) => lane.unlink(target.kind, target.id, proxyId));
      return { proxyIds: removed.map(String), target };
    },
    start_recording: async (input, ctx) => {
      const raw = objectInput(input);
      const proxyId = resolveProxyId(raw, ctx);
      const name = optionalName(raw, "name", 128);
      return serialized(async () => {
        const { store } = current();
        const entry = running.get(proxyId);
        if (entry === undefined) {
          liveProxy(proxyId);
          throw new InspectorRefusal("conflict", PROXY_DETAILS.notRunning);
        }
        if (entry.live.recordingId !== undefined) {
          throw new InspectorRefusal("conflict", PROXY_DETAILS.alreadyRecording);
        }
        const recording = await store.exclusive((lane) =>
          lane.startRecording({
            proxyId,
            startedAt: now(),
            listenHost: entry.listenHost,
            listenPort: entry.listenPort,
            ...(name === undefined ? {} : { name }),
          }),
        );
        entry.live.recordingId = recording.id;
        try {
          await entry.process.setRecording(true);
        } catch (error) {
          entry.live.recordingId = undefined;
          await closeRecording(proxyId, recording.id);
          throw new InspectorRefusal(
            "conflict",
            error instanceof Error ? error.message : "mitmdump did not start recording.",
          );
        }
        return { recordingId: String(recording.id), proxyId: String(proxyId) };
      });
    },
    stop_recording: async (input, ctx) => {
      const proxyId = resolveProxyId(objectInput(input), ctx);
      return serialized(async () => {
        const { store, log } = current();
        const open = store.openRecording(proxyId);
        if (open === undefined) return { recordingId: null, proxyId: String(proxyId) };
        const entry = running.get(proxyId);
        if (entry !== undefined) {
          await entry.process
            .setRecording(false)
            .catch(() => log("Turning recording off in mitmdump failed."));
          entry.live.recordingId = undefined;
        }
        await closeRecording(proxyId, open.id);
        return { recordingId: String(open.id), proxyId: String(proxyId) };
      });
    },
    list_recordings: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const explicit = raw.proxyId !== undefined && raw.proxyId !== null;
      const proxyId = !explicit && raw.allProxies === true ? undefined : resolveProxyId(raw, ctx);
      return {
        proxyId: proxyId === undefined ? null : String(proxyId),
        items: store.listRecordings(proxyId).slice(0, MAX_LISTED_RECORDINGS).map(recordingView),
      };
    },
    delete_recording: async (input) => {
      const { store } = current();
      const recordingId = parseId(objectInput(input).recordingId, "recording");
      await store.exclusive((lane) => lane.deleteRecording(recordingId));
      imports.get(recordingId)?.cancel();
      return { recordingId: String(recordingId) };
    },
    search_requests: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const limit = optionalInteger(raw, "limit");
      const cursor = optionalString(raw, "cursor");
      const { filter, proxyId } = scopedFilter(raw, ctx);
      const page = store.search(filter, {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return {
        items: page.items.map(summaryView),
        cursor: page.cursor,
        revision: page.revision,
        proxyId,
      };
    },
    get_request: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const id = parseId(raw.requestId, "request");
      const record = store.getRequest(id);
      if (record === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
      const previewBytes = optionalInteger(raw, "previewBytes") ?? DEFAULT_PREVIEW_BYTES;
      if (previewBytes < 0 || previewBytes > MAX_PREVIEW_BYTES) {
        throw invalid(`previewBytes must be between 0 and ${MAX_PREVIEW_BYTES}.`);
      }
      const bodies = raw.bodies ?? "none";
      if (bodies !== "none" && bodies !== "request" && bodies !== "response" && bodies !== "both") {
        throw invalid('bodies must be "none", "request", "response" or "both".');
      }
      return requestDetail(store, record, { previewBytes, bodies, redact: redactsFor(raw, ctx) });
    },
    read_body: async (input) => {
      const { readBody } = current();
      const raw = objectInput(input);
      return readBody({
        requestId: parseId(raw.requestId, "request"),
        side: parseSide(raw.side),
        offset: optionalInteger(raw, "offset") ?? -1,
        length: optionalInteger(raw, "length") ?? 0,
        decoded: raw.decoded === true,
      });
    },
    export_requests: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const format = raw.format;
      if (typeof format !== "string" || !EXPORT_FORMATS.has(format)) {
        throw invalid('format must be "har", "curl", "raw", "json", "fetch" or "python".');
      }
      const exportFormat = format as ExportFormat;
      const output = raw.output ?? "auto";
      if (output !== "auto" && output !== "inline" && output !== "file") {
        throw invalid('output must be "auto", "inline" or "file".');
      }
      const ids = parseStringList(raw.requestIds, "requestIds", MAX_EXPORT_REQUESTS, 32);
      if (ids !== undefined && raw.filter !== undefined) throw invalid(EXPORT_DETAILS.needsScope);
      const withBodies = optionalBoolean(raw, "includeBodies") ?? true;
      const redact = redactsFor(raw, ctx);
      const budget = { left: MAX_EXPORT_BYTES };
      const entries: Array<ExportEntry> = [];
      const missing: Array<string> = [];
      let matched = 0;
      if (ids !== undefined) {
        for (const id of ids) {
          const record = ID_PATTERN.test(id) ? store.getRequest(Number(id)) : undefined;
          if (record === undefined) missing.push(id);
          else entries.push(exportEntry(store, record, exportFormat, withBodies, budget, redact));
        }
      } else {
        const { filter } = scopedFilter(objectInput(raw.filter), ctx);
        const cap = deps.maxExportRequests ?? MAX_EXPORT_REQUESTS;
        const records: Array<RequestRecord> = [];
        let cursor: string | undefined;
        do {
          const page = store.search(filter, {
            limit: STORE_LIMITS.maxSearchLimit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          matched += page.items.length;
          for (const summary of page.items) {
            if (records.length >= cap) break;
            const record = store.getRequest(summary.id);
            if (record !== undefined) records.push(record);
          }
          cursor = page.cursor ?? undefined;
        } while (cursor !== undefined);
        // Search is newest first; an export reads oldest first.
        for (const record of records.toReversed()) {
          entries.push(exportEntry(store, record, exportFormat, withBodies, budget, redact));
        }
      }
      const { text, count } = exportRequests(entries, {
        format: format as ExportFormat,
        creator: EXPORT_CREATOR,
        includeBodies: withBodies,
      });
      const data = Buffer.from(text, "utf8");
      if (data.byteLength > MAX_EXPORT_BYTES) throw invalid(EXPORT_DETAILS.tooLarge);
      const base = {
        format,
        count,
        bytes: data.byteLength,
        ...(missing.length === 0 ? {} : { missing }),
        ...(matched > entries.length ? { truncated: true, matched } : {}),
      };
      // Escaping can grow control bytes sixfold, so the encoded result must fit one payload.
      const inline = { ...base, inline: text };
      const fitsInline =
        data.byteLength <= INLINE_EXPORT_BYTES && jsonBytes(inline) <= PAYLOAD_BYTES;
      if (output === "inline" && !fitsInline) throw invalid(EXPORT_DETAILS.inlineTooLarge);
      if (output !== "file" && fitsInline) return inline;
      const exportId = NodeCrypto.randomBytes(8).toString("hex");
      const fileName = `requests-${exportId}.${EXPORT_EXTENSIONS[format as ExportFormat]}`;
      const record = await store.exclusive((lane) => {
        if (lane.admitExport(data.byteLength) === "full") {
          throw new InspectorRefusal("storage-full", EXPORT_DETAILS.storageFull);
        }
        NodeFS.mkdirSync(store.exportsDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(store.exportsDir, fileName), data, { mode: 0o600 });
        lane.noteFileWrite();
        return lane.addExport({
          id: exportId,
          createdAt: now(),
          fileName,
          bytes: data.byteLength,
        });
      });
      return { ...base, file: { exportId: record.id, path: record.path, bytes: record.bytes } };
    },
    read_export: async (input) => {
      const { store } = current();
      const raw = objectInput(input);
      const exportId = optionalString(raw, "exportId");
      const offset = optionalInteger(raw, "offset") ?? 0;
      const length = optionalInteger(raw, "length") ?? MAX_EXPORT_READ_BYTES;
      if (offset < 0) throw invalid("offset must be at least 0.");
      if (length < 1 || length > MAX_EXPORT_READ_BYTES) {
        throw invalid(`length must be between 1 and ${MAX_EXPORT_READ_BYTES}.`);
      }
      const record = store.listExports().find((candidate) => candidate.id === exportId);
      if (record === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.export);
      let fd: number;
      try {
        fd = NodeFS.openSync(record.path, "r");
      } catch {
        throw new InspectorRefusal("not-found", MISSING_DETAILS.export);
      }
      try {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, record.bytes - offset)));
        const read =
          buffer.byteLength === 0 ? 0 : NodeFS.readSync(fd, buffer, 0, buffer.byteLength, offset);
        return {
          base64: buffer.subarray(0, read).toString("base64"),
          offset,
          totalBytes: record.bytes,
          eof: offset + read >= record.bytes,
        };
      } finally {
        NodeFS.closeSync(fd);
      }
    },
    format_headers: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const record = store.getRequest(parseId(raw.requestId, "request"));
      if (record === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
      const side = parseSide(raw.side);
      const format = raw.format;
      if (typeof format !== "string" || !HEADER_FORMATS.has(format)) {
        throw invalid(
          'format must be "raw", "json", "curl", "cookie-header", "netscape", "js" or "python".',
        );
      }
      const names = parseStringList(raw.names, "names", 256, 256);
      const cookies =
        typeof raw.cookies === "boolean"
          ? raw.cookies
          : parseStringList(raw.cookies, "cookies", 256, 256);
      const pairs = side === "request" ? record.requestHeaders : (record.response?.headers ?? []);
      const text = formatHeaders({
        headers: headerText(pairs, redactsFor(raw, ctx)),
        side,
        request: { host: record.summary.host, path: record.path },
        capturedAt: record.summary.startedAt,
        names,
        cookies,
        format: format as HeaderFormat,
      });
      return fitFormattedHeaders(text);
    },
    decode_value: async (input, ctx) => {
      const { store } = current();
      const raw = objectInput(input);
      const source = objectInput(raw.source);
      let bytes: Buffer;
      if (typeof source.text === "string") {
        bytes = Buffer.from(source.text, "utf8");
      } else if (typeof source.base64 === "string") {
        if (!BASE64_TEXT.test(source.base64)) throw invalid(REPLAY_INPUT_DETAILS.base64);
        bytes = Buffer.from(source.base64, "base64");
      } else if (source.requestId !== undefined) {
        const record = store.getRequest(parseId(source.requestId, "request"));
        if (record === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
        const side = parseSide(source.side);
        const header = optionalString(source, "header");
        if (header !== undefined) {
          const pairs = side === "request" ? record.requestHeaders : record.response?.headers;
          const wanted = header.toLowerCase();
          if (isSensitiveHeader(wanted) && redactsFor(raw, ctx)) {
            throw invalid(sensitiveHeaderDetail(header));
          }
          const found = pairs?.find(
            ([name]) => Buffer.from(name).toString("latin1").toLowerCase() === wanted,
          );
          if (found === undefined) throw invalid(`The ${side} has no ${header} header.`);
          bytes = Buffer.from(found[1]);
        } else {
          const stored = store.readBody(record.summary.id, side);
          const meta = side === "request" ? record.requestBody : record.response?.body;
          bytes =
            stored === undefined
              ? Buffer.alloc(0)
              : (decodedOrUndefined(stored.bytes, meta?.contentEncoding) ?? stored.bytes);
        }
      } else {
        throw invalid('source must be { "text" }, { "base64" } or { "requestId", "side" }.');
      }
      if (bytes.byteLength > DECODE_LIMITS.maxInputBytes) {
        throw invalid("The decode input is larger than 1 MiB.");
      }
      const steps = parseDecodeSteps(raw.steps);
      if (!steps.ok) throw invalid(`${steps.reason}.`);
      return fitDecodeResult(decodeChain(bytes, steps.steps));
    },
    certificate_info: async (input, ctx) => {
      const { dataDir } = current();
      const raw = objectInput(input);
      let proxyUrl: string | undefined;
      let proxyId: number | undefined;
      try {
        proxyId = resolveProxyId(raw, ctx);
      } catch (error) {
        // The certificate is shared by every proxy; only an unknown explicit id is an error.
        if (raw.proxyId !== undefined) throw error;
      }
      const entry = proxyId === undefined ? undefined : running.get(proxyId);
      if (entry !== undefined) proxyUrl = endpoint(entry).proxyUrl;
      const confdir = NodePath.join(dataDir, CONFDIR);
      const options = { confdir, dataDir, ...(proxyUrl === undefined ? {} : { proxyUrl }) };
      let info = await certificateInfo(options, nssDeps());
      if (!info.exists) {
        await ensureCa();
        info = await certificateInfo(options, nssDeps());
      }
      return { ...info, proxyId: proxyId === undefined ? null : String(proxyId) };
    },
    install_certificate_nss: async (input) => {
      const { dataDir } = current();
      const dbs = parseStringList(objectInput(input).dbs, "dbs", MAX_NSS_DBS, 4096);
      await ensureCa();
      const pem = caFiles(NodePath.join(dataDir, CONFDIR), deps.certFs).files.pem;
      return { results: await nssInstall(nssDeps(), pem, dbs).catch(nssFailure) };
    },
    uninstall_certificate_nss: async (input) => {
      const dbs = parseStringList(objectInput(input).dbs, "dbs", MAX_NSS_DBS, 4096);
      return { results: await nssUninstall(nssDeps(), dbs).catch(nssFailure) };
    },
    preview_replay: async (input, ctx: OperationContext) =>
      current().replay.preview(replayInput(objectInput(input), ctx)),
    replay_request: async (input, ctx: OperationContext) => {
      const raw = objectInput(input);
      const idempotencyKey = optionalString(raw, "idempotencyKey");
      if (idempotencyKey === undefined || idempotencyKey === "") {
        throw invalid(REPLAY_INPUT_DETAILS.keyRequired);
      }
      return current().replay.accept({ ...replayInput(raw, ctx), idempotencyKey }, ctx.signal);
    },
    get_replay: async (input, ctx: OperationContext) => {
      const raw = objectInput(input);
      const replayId = optionalString(raw, "replayId");
      if (replayId === undefined) throw invalid("replayId is required.");
      const waitMs = optionalInteger(raw, "waitMs") ?? 0;
      if (waitMs < 0 || waitMs > REPLAY_LIMITS.maxWaitMs) {
        throw invalid(`waitMs must be between 0 and ${REPLAY_LIMITS.maxWaitMs}.`);
      }
      return current().replay.get(replayId, { waitMs, signal: ctx.signal });
    },
    import_flows: async (input, ctx) => {
      const raw = objectInput(input);
      const source = importSource(raw);
      const proxyId = resolveProxyId(raw, ctx);
      liveProxy(proxyId);
      const name = optionalName(raw, "name", 128) ?? source.name.slice(0, 128);
      const active = [...imports.values()].filter((job) => job.state === "running").length;
      if (active + startingImports.size >= MAX_RUNNING_IMPORTS) {
        throw new InspectorRefusal("conflict", IMPORT_DETAILS.limit);
      }
      const { file, cleanup } = source.take();
      const start = startImport(proxyId, name, file, cleanup);
      startingImports.set(start, proxyId);
      try {
        return importView(await start);
      } catch (error) {
        cleanup();
        throw error;
      } finally {
        startingImports.delete(start);
      }
    },
    get_import: async (input, ctx) => {
      const raw = objectInput(input);
      const job = imports.get(parseId(raw.recordingId, "recording"));
      if (job === undefined) throw new InspectorRefusal("not-found", IMPORT_DETAILS.missing);
      const waitMs = optionalInteger(raw, "waitMs") ?? 0;
      if (waitMs < 0 || waitMs > REPLAY_LIMITS.maxWaitMs) {
        throw invalid(`waitMs must be between 0 and ${REPLAY_LIMITS.maxWaitMs}.`);
      }
      if (job.state === "running" && waitMs > 0 && !ctx.signal.aborted) {
        await new Promise<void>((resolve) => {
          const cancel = timer.after(waitMs, resolve);
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
          void job.finished.then(() => {
            cancel();
            resolve();
          });
        });
      }
      return importView(job);
    },
    import_upload_write: async (input) => {
      const raw = objectInput(input);
      const uploadId = optionalString(raw, "uploadId");
      const base64 = optionalString(raw, "base64");
      if (base64 === undefined) throw invalid("base64 is required.");
      const { uploads, config } = current();
      if (uploadId === undefined) {
        // Refused before any chunk is admitted, so a file that cannot fit prunes nothing.
        const size = optionalInteger(raw, "size");
        if (size === undefined || size < 1) throw invalid(IMPORT_DETAILS.uploadSize);
        if (size > Math.min(UPLOADS.maxBytes, Math.floor(config.maxDiskBytes / 2))) {
          throw invalid(IMPORT_DETAILS.uploadTooLarge);
        }
      }
      const result = await uploads.write({
        ...(uploadId === undefined ? {} : { draftId: uploadId }),
        offset: optionalInteger(raw, "offset") ?? -1,
        base64,
      });
      return { uploadId: result.draftId, size: result.size };
    },
    import_upload_discard: async (input) => {
      const { store, uploads } = current();
      const uploadId = optionalString(objectInput(input), "uploadId");
      if (uploadId === undefined) throw invalid("uploadId is required.");
      if (uploads.path(uploadId) !== undefined) {
        await store.exclusive((lane) => uploads.remove(lane, uploadId));
      }
      return { uploadId };
    },
    body_draft_write: async (input) => {
      const raw = objectInput(input);
      const draftId = optionalString(raw, "draftId");
      const base64 = optionalString(raw, "base64");
      if (base64 === undefined) throw invalid("base64 is required.");
      return current().drafts.write({
        ...(draftId === undefined ? {} : { draftId }),
        offset: optionalInteger(raw, "offset") ?? -1,
        base64,
      });
    },
  };

  return {
    operations,
    topics: {
      proxies: subscribeProxies,
      requests: subscribeRequests,
    },
    resolveReference: async (locator) => {
      const { store } = current();
      const id = parseId(locator.requestId, "request");
      const record = store.getRequest(id);
      // 0.1 references name the recording `captureId`.
      const recordingId = locator.recordingId ?? locator.captureId;
      if (record === undefined || String(record.summary.recordingId) !== recordingId) {
        throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
      }
      const { summary } = record;
      const lines = [
        `${summary.method} ${summary.scheme}://${requestOrigin({ ...summary, authority: record.authority })}${record.path}`,
        ...shapeHeaders(record.requestHeaders, true).headers.map(
          ([name, value]) => `${name}: ${value}`,
        ),
      ];
      if (record.response !== undefined) {
        lines.push(
          "",
          `${record.response.status}${record.response.reason ? ` ${record.response.reason}` : ""}`,
          ...shapeHeaders(record.response.headers, true).headers.map(
            ([name, value]) => `${name}: ${value}`,
          ),
        );
      } else if (summary.error !== undefined) {
        lines.push("", `Error: ${summary.error}`);
      }
      lines.push("", "Bodies are not included. Read them with get_request or read_body.");
      const detail = lines.join("\n");
      return {
        title: `${summary.method} ${summary.host}${summary.path}`.slice(0, 200),
        detail:
          detail.length > REFERENCE_DETAIL_CHARS
            ? `${detail.slice(0, REFERENCE_DETAIL_CHARS - 1)}…`
            : detail,
      };
    },
    onStart: async (ctx) => {
      const config = { ...readInspectorConfig(ctx.config), ...deps.configOverrides };
      const log = ctx.log;
      const store = openInspectorStore({
        dataDir: ctx.dataDir,
        maxDiskBytes: config.maxDiskBytes,
        maxBodyBytes: config.maxBodyBytes,
        defaultProxyOptions: {
          listenHost: config.listenHost,
          listenPort: "auto",
          mode: { kind: "regular" },
          passthroughHosts: [],
          ignoredHosts: [],
        },
        log,
        ...(deps.onStorageStep === undefined ? {} : { onStorageStep: deps.onStorageStep }),
      });
      const drafts = makeDraftStore(store);
      const uploads = makeDraftStore(store, UPLOADS);
      const mitm = makeMitm({
        dataDir: ctx.dataDir,
        addonSource: deps.addonSource,
        maxBodyBytes: config.maxBodyBytes,
        materialize: deps.materialize ?? materializeAsset,
        timer,
        log,
        ...(deps.spawner === undefined ? {} : { spawner: deps.spawner }),
        ...(deps.searchPath === undefined ? {} : { searchPath: deps.searchPath }),
        ...(deps.probePort === undefined ? {} : { probePort: deps.probePort }),
      });
      const replay = makeReplayService({
        store,
        drafts,
        timer,
        now,
        log,
        ...(deps.maxReplayHistory === undefined ? {} : { maxReplayHistory: deps.maxReplayHistory }),
        carriers: { carrierFor },
      });
      session = {
        store,
        drafts,
        uploads,
        readBody: makeBodyReader(store),
        replay,
        mitm,
        config,
        dataDir: ctx.dataDir,
        log,
      };
      await replay.recover();
      // No proxy outlives the worker, so a recording still open was left by a crash.
      await store.exclusive((lane) => {
        drafts.clear(lane);
        for (const proxy of store.listProxies()) {
          const open = store.openRecording(proxy.id);
          if (open !== undefined) lane.stopRecording(open.id, now());
        }
      });
    },
    onStop: async () => {
      const active = session;
      if (active === undefined) return;
      await Promise.allSettled(startingImports.keys());
      await Promise.all([
        ...[...running.values()].map((entry) => stopEntry(entry, "stop")),
        ...[...imports.values()].filter((job) => job.state === "running").map((job) => job.stop()),
      ]);
      await active.replay.stop();
      active.store.close();
      session = undefined;
    },
  };
}
