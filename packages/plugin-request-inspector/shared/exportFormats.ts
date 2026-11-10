// @effect-diagnostics globalDate:off - Shared by the plugin frame and the builtin-only backend, outside any Effect runtime.
import { parseCookieHeader, parseSetCookie, shellQuote } from "./headerFormats.ts";
import {
  type BodyInput,
  bodyText,
  bytesToBase64,
  type HeaderList,
  headerValue,
  type HttpRequestInput,
  type HttpResponseInput,
  isPseudoHeader,
  rawRequest,
  rawResponse,
  requestUrl,
} from "./httpText.ts";

export type ExportFormat = "har" | "curl" | "raw" | "json" | "fetch" | "python";

export interface ExportEntry {
  readonly id: string;
  readonly flowType: "http" | "websocket" | "tunnel" | "other";
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly request: HttpRequestInput;
  readonly response?: HttpResponseInput | undefined;
  readonly error?: string | undefined;
  readonly sni?: string | undefined;
  readonly clientAddr?: string | undefined;
  readonly bytesUp?: number | undefined;
  readonly bytesDown?: number | undefined;
}

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly creator: { readonly name: string; readonly version: string };
  readonly includeBodies?: boolean | undefined;
}

export interface ExportResult {
  readonly text: string;
  /** Entries written; tunnels are counted only by JSON. */
  readonly count: number;
}

interface Settings {
  readonly bodies: boolean;
}

/** Headers a client recomputes from the URL and body, which must not be replayed verbatim. */
const DERIVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

const replayHeaders = (headers: HeaderList) =>
  headers.filter(([name]) => !isPseudoHeader(name) && !DERIVED_HEADERS.has(name.toLowerCase()));

const sentBody = (request: HttpRequestInput, settings: Settings) =>
  settings.bodies && request.body !== undefined && request.body.bytes.length > 0
    ? request.body
    : undefined;

// HAR 1.2: http://www.softwareishard.com/blog/har-12-spec/
function harContent(body: BodyInput | undefined, settings: Settings) {
  if (body === undefined) return { size: 0, mimeType: "" };
  const bytes = body.decoded ?? body.bytes;
  const base = {
    size: bytes.length,
    mimeType: body.contentType ?? "",
    ...(body.decoded === undefined ? {} : { compression: bytes.length - body.bytes.length }),
    ...(body.truncated ? { _truncated: true } : {}),
  };
  if (!settings.bodies || bytes.length === 0) return base;
  const text = bodyText(bytes, body.contentType);
  return text === undefined
    ? { ...base, text: bytesToBase64(bytes), encoding: "base64" }
    : { ...base, text };
}

function harPostData(body: BodyInput | undefined, settings: Settings) {
  if (body === undefined || body.bytes.length === 0) return {};
  const mimeType = body.contentType ?? "";
  if (!settings.bodies) return { postData: { mimeType, text: "" } };
  const text = bodyText(body.bytes, body.contentType);
  // HAR has no binary postData; `_encoding` follows the custom-field rule.
  return {
    postData:
      text === undefined
        ? { mimeType, text: bytesToBase64(body.bytes), _encoding: "base64" }
        : { mimeType, text },
  };
}

function harQuery(path: string) {
  const query = path.split("#", 1)[0]?.split("?").slice(1).join("?") ?? "";
  if (query === "") return [];
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text.replaceAll("+", " "));
    } catch {
      return text;
    }
  };
  return query.split("&").map((part) => {
    const eq = part.indexOf("=");
    return eq < 0
      ? { name: decode(part), value: "" }
      : { name: decode(part.slice(0, eq)), value: decode(part.slice(eq + 1)) };
  });
}

const harHeaders = (headers: HeaderList) => headers.map(([name, value]) => ({ name, value }));

const bodySize = (body: BodyInput | undefined) =>
  body === undefined ? 0 : (body.declaredBytes ?? body.bytes.length);

function harRequestCookies(headers: HeaderList) {
  return headers
    .filter(([name]) => name.toLowerCase() === "cookie")
    .flatMap(([, value]) => parseCookieHeader(value));
}

function harResponseCookies(headers: HeaderList) {
  return headers
    .filter(([name]) => name.toLowerCase() === "set-cookie")
    .flatMap(([, value]) => {
      const cookie = parseSetCookie(value);
      if (cookie === undefined) return [];
      const expires = cookie.expires === undefined ? Number.NaN : Date.parse(cookie.expires);
      return [
        {
          name: cookie.name,
          value: cookie.value,
          ...(cookie.path === undefined ? {} : { path: cookie.path }),
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          ...(Number.isNaN(expires) ? {} : { expires: new Date(expires).toISOString() }),
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
        },
      ];
    });
}

function harEntry(entry: ExportEntry, settings: Settings) {
  const { request, response } = entry;
  const time = entry.endedAt === undefined ? 0 : Math.max(0, entry.endedAt - entry.startedAt);
  return {
    startedDateTime: new Date(entry.startedAt).toISOString(),
    time,
    request: {
      method: request.method,
      url: requestUrl(request),
      httpVersion: request.httpVersion,
      cookies: harRequestCookies(request.headers),
      headers: harHeaders(request.headers),
      queryString: harQuery(request.path),
      ...harPostData(request.body, settings),
      headersSize: -1,
      bodySize: bodySize(request.body),
    },
    response:
      response === undefined
        ? {
            status: 0,
            statusText: "",
            httpVersion: "",
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: "" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          }
        : {
            status: response.status,
            statusText: response.reason ?? "",
            httpVersion: response.httpVersion,
            cookies: harResponseCookies(response.headers),
            headers: harHeaders(response.headers),
            content: harContent(response.body, settings),
            redirectURL: headerValue(response.headers, "location") ?? "",
            headersSize: -1,
            bodySize: bodySize(response.body),
          },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: time, receive: 0 },
    ...(entry.error === undefined ? {} : { _error: entry.error }),
    _id: entry.id,
    ...(entry.flowType === "websocket" ? { _resourceType: "websocket" } : {}),
  };
}

// Inline bodies use --data-raw: --data-binary would read a body starting with "@" as a file path.
function curlBody(body: BodyInput): { arg: string; stdin?: string } {
  const text = bodyText(body.bytes);
  if (text !== undefined) return { arg: `--data-raw ${shellQuote(text)}` };
  if (!body.bytes.includes(0)) {
    let out = "";
    for (const byte of body.bytes) {
      if (byte === 0x5c || byte === 0x27) out += `\\${String.fromCharCode(byte)}`;
      else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
      else out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
    return { arg: `--data-raw $'${out}'` };
  }
  // No argv string can hold NUL, so printf's octal escapes feed the body on stdin.
  let format = "";
  for (const byte of body.bytes) {
    if (byte === 0x5c) format += "\\\\";
    else if (byte === 0x25) format += "%%";
    else if (byte === 0x27) format += "'\\''";
    else if (byte >= 0x20 && byte < 0x7f) format += String.fromCharCode(byte);
    else format += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return { arg: "--data-binary @-", stdin: `printf '${format}' | ` };
}

function curlCommand(entry: ExportEntry, settings: Settings) {
  const { request } = entry;
  const method = request.method.toUpperCase();
  const sent = sentBody(request, settings);
  const body = sent === undefined ? undefined : curlBody(sent);
  const defaultMethod = body === undefined ? "GET" : "POST";
  const target = shellQuote(requestUrl(request));
  const args = [
    method === defaultMethod ? target : `-X ${shellQuote(request.method)} ${target}`,
    ...replayHeaders(request.headers).map(
      ([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`,
    ),
    ...(body === undefined ? [] : [body.arg]),
  ];
  const note = request.body?.truncated
    ? `# The captured request body was truncated at ${request.body.bytes.length} bytes.\n`
    : "";
  return `${note}${body?.stdin ?? ""}curl ${args.join(" \\\n  ")}`;
}

function fetchSnippet(entry: ExportEntry, settings: Settings) {
  const { request } = entry;
  const headers = replayHeaders(request.headers);
  const method = request.method.toUpperCase();
  const lines = [`  method: ${JSON.stringify(request.method)},`];
  if (headers.length > 0)
    lines.push(
      `  headers: [\n${headers.map(([name, value]) => `    [${JSON.stringify(name)}, ${JSON.stringify(value)}],`).join("\n")}\n  ],`,
    );
  const body = sentBody(request, settings);
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    const text = bodyText(body.bytes);
    lines.push(
      text === undefined
        ? `  body: Uint8Array.from(atob(${JSON.stringify(bytesToBase64(body.bytes))}), (c) => c.charCodeAt(0)),`
        : `  body: ${JSON.stringify(text)},`,
    );
  }
  return `await fetch(${JSON.stringify(requestUrl(request))}, {\n${lines.join("\n")}\n});`;
}

function pythonSnippet(entry: ExportEntry, settings: Settings) {
  const { request } = entry;
  const merged = new Map<string, [string, string[]]>();
  for (const [name, value] of replayHeaders(request.headers)) {
    const key = name.toLowerCase();
    const found = merged.get(key);
    if (found === undefined) merged.set(key, [name, [value]]);
    else found[1].push(value);
  }
  const lines = [
    `    ${JSON.stringify(request.method)},`,
    `    ${JSON.stringify(requestUrl(request))},`,
  ];
  if (merged.size > 0)
    lines.push(
      `    headers={\n${[...merged.entries()]
        .map(
          ([key, [name, values]]) =>
            `        ${JSON.stringify(name)}: ${JSON.stringify(values.join(key === "cookie" ? "; " : ", "))},`,
        )
        .join("\n")}\n    },`,
    );
  let binary = false;
  const body = sentBody(request, settings);
  if (body !== undefined) {
    const text = bodyText(body.bytes);
    binary = text === undefined;
    // JSON string literals are valid Python literals; `.encode()` sends UTF-8, not latin1.
    lines.push(
      text === undefined
        ? `    data=base64.b64decode(${JSON.stringify(bytesToBase64(body.bytes))}),`
        : `    data=${JSON.stringify(text)}.encode(),`,
    );
  }
  return { binary, code: `response = requests.request(\n${lines.join("\n")}\n)` };
}

function rawEntry(entry: ExportEntry, settings: Settings) {
  const options = { includeBody: settings.bodies };
  const request = rawRequest(entry.request, options);
  if (entry.response === undefined) return request;
  return `${request}\n\n${rawResponse(entry.response, options)}`;
}

function jsonBody(body: BodyInput | undefined, settings: Settings) {
  if (body === undefined) return undefined;
  const bytes = body.decoded ?? body.bytes;
  const text = settings.bodies ? bodyText(bytes, body.contentType) : undefined;
  return {
    bytes: body.bytes.length,
    ...(body.declaredBytes === undefined ? {} : { declaredBytes: body.declaredBytes }),
    truncated: body.truncated ?? false,
    ...(body.contentType === undefined ? {} : { contentType: body.contentType }),
    ...(body.contentEncoding === undefined ? {} : { contentEncoding: body.contentEncoding }),
    decoded: body.decoded !== undefined,
    ...(!settings.bodies ? {} : text === undefined ? { base64: bytesToBase64(bytes) } : { text }),
  };
}

function jsonEntry(entry: ExportEntry, settings: Settings) {
  const { request, response } = entry;
  return {
    id: entry.id,
    flowType: entry.flowType,
    startedAt: entry.startedAt,
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    method: request.method,
    url: requestUrl(request),
    httpVersion: request.httpVersion,
    ...(entry.flowType === "tunnel"
      ? {
          sni: entry.sni ?? null,
          clientAddr: entry.clientAddr ?? null,
          bytesUp: entry.bytesUp ?? 0,
          bytesDown: entry.bytesDown ?? 0,
        }
      : {}),
    request: { headers: request.headers, body: jsonBody(request.body, settings) ?? null },
    response:
      response === undefined
        ? null
        : {
            status: response.status,
            reason: response.reason ?? "",
            httpVersion: response.httpVersion,
            headers: response.headers,
            body: jsonBody(response.body, settings) ?? null,
          },
    error: entry.error ?? null,
  };
}

export function exportRequests(
  entries: ReadonlyArray<ExportEntry>,
  options: ExportOptions,
): ExportResult {
  const settings: Settings = {
    bodies: options.includeBodies ?? true,
  };
  if (options.format === "json") {
    const requests = entries.map((entry) => jsonEntry(entry, settings));
    return {
      text: JSON.stringify({ creator: options.creator, requests }, null, 2),
      count: requests.length,
    };
  }
  const flows = entries.filter((entry) => entry.flowType !== "tunnel");
  switch (options.format) {
    case "har":
      return {
        text: JSON.stringify(
          {
            log: {
              version: "1.2",
              creator: options.creator,
              pages: [],
              entries: flows.map((entry) => harEntry(entry, settings)),
            },
          },
          null,
          2,
        ),
        count: flows.length,
      };
    case "curl":
      return {
        text: flows.map((entry) => curlCommand(entry, settings)).join("\n\n"),
        count: flows.length,
      };
    case "raw":
      return {
        text: flows.map((entry) => rawEntry(entry, settings)).join("\n\n"),
        count: flows.length,
      };
    case "fetch":
      return {
        text: flows.map((entry) => fetchSnippet(entry, settings)).join("\n\n"),
        count: flows.length,
      };
    case "python": {
      const snippets = flows.map((entry) => pythonSnippet(entry, settings));
      const imports = snippets.some((snippet) => snippet.binary)
        ? "import base64\n\nimport requests"
        : "import requests";
      return {
        text: [imports, ...snippets.map((snippet) => snippet.code)].join("\n\n"),
        count: flows.length,
      };
    }
  }
}
