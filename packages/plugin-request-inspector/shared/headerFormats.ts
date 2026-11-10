import { type HeaderList, isPseudoHeader } from "./httpText.ts";

export type HeaderFormat = "raw" | "json" | "curl" | "cookie-header" | "netscape" | "js" | "python";

export interface Cookie {
  readonly name: string;
  readonly value: string;
}

export interface SetCookie extends Cookie {
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: string;
  readonly maxAge?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: string;
}

export interface FormatHeadersInput {
  readonly headers: HeaderList;
  readonly side: "request" | "response";
  /** The request the headers belong to; Netscape rows take its host and path. */
  readonly request: { readonly host: string; readonly path: string };
  /** Epoch ms the response arrived, which `Max-Age` counts from. */
  readonly capturedAt?: number | undefined;
  /** Header names to keep, case-insensitive. All headers when omitted. */
  readonly names?: ReadonlyArray<string> | undefined;
  /** `false` drops cookies, a list keeps only those names, otherwise all are kept. */
  readonly cookies?: boolean | ReadonlyArray<string> | undefined;
  readonly format: HeaderFormat;
}

export function parseCookieHeader(value: string): Cookie[] {
  return value.split(";").flatMap((part) => {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? "" : part.slice(0, eq)).trim();
    const cookieValue = (eq < 0 ? part : part.slice(eq + 1)).trim();
    return name === "" && cookieValue === "" ? [] : [{ name, value: cookieValue }];
  });
}

export function parseSetCookie(header: string): SetCookie | undefined {
  const [pair = "", ...attributes] = header.split(";");
  const [cookie] = parseCookieHeader(pair);
  if (cookie === undefined) return undefined;
  const found = new Map<string, string>();
  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    const key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
    found.set(key, eq < 0 ? "" : attribute.slice(eq + 1).trim());
  }
  const domain = found.get("domain");
  const path = found.get("path");
  const expires = found.get("expires");
  const maxAge = found.get("max-age");
  const sameSite = found.get("samesite");
  return {
    ...cookie,
    ...(domain ? { domain: domain.toLowerCase() } : {}),
    ...(path?.startsWith("/") ? { path } : {}),
    ...(expires ? { expires } : {}),
    ...(maxAge !== undefined && /^-?\d+$/.test(maxAge) ? { maxAge: Number(maxAge) } : {}),
    secure: found.has("secure"),
    httpOnly: found.has("httponly"),
    ...(sameSite ? { sameSite } : {}),
  };
}

const cookiePair = (cookie: Cookie) =>
  cookie.name === "" ? cookie.value : `${cookie.name}=${cookie.value}`;

const cookieHeaderName = (side: FormatHeadersInput["side"]) =>
  side === "request" ? "cookie" : "set-cookie";

const keepCookie = (cookies: FormatHeadersInput["cookies"], name: string) =>
  cookies === undefined || cookies === true || (Array.isArray(cookies) && cookies.includes(name));

function selectedCookies(input: FormatHeadersInput): SetCookie[] {
  if (input.cookies === false) return [];
  const headerName = cookieHeaderName(input.side);
  return input.headers
    .filter(([name]) => name.toLowerCase() === headerName)
    .flatMap(([, value]): SetCookie[] => {
      if (input.side === "response") {
        const parsed = parseSetCookie(value);
        return parsed === undefined ? [] : [parsed];
      }
      return parseCookieHeader(value).map((cookie) => ({
        ...cookie,
        secure: false,
        httpOnly: false,
      }));
    })
    .filter((cookie) => keepCookie(input.cookies, cookie.name));
}

/** Applies `names` and narrows the cookie headers to the chosen cookies. */
function selectedHeaders(input: FormatHeadersInput): Array<[string, string]> {
  const names = input.names?.map((name) => name.toLowerCase());
  const cookieName = cookieHeaderName(input.side);
  return input.headers
    .filter(([name]) => !isPseudoHeader(name))
    .filter(([name]) => names === undefined || names.includes(name.toLowerCase()))
    .flatMap(([name, value]): Array<[string, string]> => {
      if (
        name.toLowerCase() !== cookieName ||
        input.cookies === undefined ||
        input.cookies === true
      )
        return [[name, value]];
      if (input.cookies === false) return [];
      if (input.side === "response") {
        const parsed = parseSetCookie(value);
        return parsed !== undefined && keepCookie(input.cookies, parsed.name)
          ? [[name, value]]
          : [];
      }
      const kept = parseCookieHeader(value).filter((cookie) =>
        keepCookie(input.cookies, cookie.name),
      );
      return kept.length === 0 ? [] : [[name, kept.map(cookiePair).join("; ")]];
    });
}

/** POSIX shell quoting; text with control characters uses bash `$'…'`. */
export function shellQuote(text: string): string {
  if (!/[\u0000-\u001f\u007f]/.test(text)) return `'${text.replaceAll("'", "'\\''")}'`;
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "\\" || char === "'") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `$'${out}'`;
}

/** RFC 6265 §5.1.4 default-path of a request path. */
export function defaultCookiePath(requestPath: string): string {
  const path = requestPath.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/")) return "/";
  const last = path.lastIndexOf("/");
  return last <= 0 ? "/" : path.slice(0, last);
}

function cookieExpiry(cookie: SetCookie, capturedAt: number | undefined): number {
  if (cookie.maxAge !== undefined && capturedAt !== undefined)
    return Math.max(1, Math.floor(capturedAt / 1000) + cookie.maxAge);
  if (cookie.expires !== undefined) {
    const parsed = Date.parse(cookie.expires);
    if (!Number.isNaN(parsed)) return Math.max(1, Math.floor(parsed / 1000));
  }
  return 0;
}

const sanitizeJarField = (text: string) => text.replace(/[\t\r\n]/g, " ");

function netscapeJar(input: FormatHeadersInput, cookies: ReadonlyArray<SetCookie>) {
  const rows = cookies.map((cookie) => {
    const domain =
      cookie.domain === undefined
        ? input.request.host.toLowerCase()
        : `.${cookie.domain.replace(/^\./, "")}`;
    return [
      `${cookie.httpOnly ? "#HttpOnly_" : ""}${domain}`,
      cookie.domain === undefined ? "FALSE" : "TRUE",
      cookie.path ?? defaultCookiePath(input.request.path),
      cookie.secure ? "TRUE" : "FALSE",
      String(cookieExpiry(cookie, input.capturedAt)),
      sanitizeJarField(cookie.name),
      sanitizeJarField(cookie.value),
    ].join("\t");
  });
  return ["# Netscape HTTP Cookie File", ...rows].join("\n");
}

function pythonDict(headers: ReadonlyArray<readonly [string, string]>) {
  const merged = new Map<string, [string, string[]]>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const entry = merged.get(key);
    if (entry === undefined) merged.set(key, [name, [value]]);
    else entry[1].push(value);
  }
  const lines = [...merged.entries()].map(([key, [name, values]]) => {
    const joined = values.join(key === "cookie" ? "; " : ", ");
    return `    ${JSON.stringify(name)}: ${JSON.stringify(joined)},`;
  });
  return lines.length === 0 ? "headers = {}" : `headers = {\n${lines.join("\n")}\n}`;
}

export function formatHeaders(input: FormatHeadersInput): string {
  if (input.format === "cookie-header") return selectedCookies(input).map(cookiePair).join("; ");
  if (input.format === "netscape") return netscapeJar(input, selectedCookies(input));
  const headers = selectedHeaders(input);
  switch (input.format) {
    case "raw":
      return headers.map(([name, value]) => `${name}: ${value}`).join("\n");
    case "json":
      return JSON.stringify(
        headers.map(([name, value]) => ({ name, value })),
        null,
        2,
      );
    case "curl":
      return headers.map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`).join(" \\\n");
    case "js":
      return headers.length === 0
        ? "const headers = new Headers();"
        : `const headers = new Headers([\n${headers
            .map(([name, value]) => `  [${JSON.stringify(name)}, ${JSON.stringify(value)}],`)
            .join("\n")}\n]);`;
    case "python":
      return pythonDict(headers);
  }
}
