import { requestOrigin } from "../backend/origin.ts";

/** Header pairs in wire order, decoded as latin1 the way `get_request` shows them. */
export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;

export interface BodyInput {
  /** The captured bytes, still content-encoded. */
  readonly bytes: Uint8Array;
  readonly truncated?: boolean | undefined;
  readonly declaredBytes?: number | undefined;
  readonly contentType?: string | undefined;
  readonly contentEncoding?: string | undefined;
  /** `bytes` with the content-encoding removed, when the caller could decode it. */
  readonly decoded?: Uint8Array | undefined;
}

export interface HttpRequestInput {
  readonly method: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly authority?: string | undefined;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: HeaderList;
  readonly body?: BodyInput | undefined;
}

export interface HttpResponseInput {
  readonly status: number;
  readonly reason?: string | undefined;
  readonly httpVersion: string;
  readonly headers: HeaderList;
  readonly body?: BodyInput | undefined;
}

export interface RawTextOptions {
  readonly includeBody?: boolean | undefined;
}

const TEXT_TYPE =
  /^\s*(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)|[^;]*\+(?:json|xml))/i;

const utf8 = new TextDecoder("utf-8");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The body as UTF-8 text, or undefined when its type or bytes say it is binary. */
export function bodyText(bytes: Uint8Array, contentType?: string): string | undefined {
  if (contentType !== undefined && contentType.trim() !== "" && !TEXT_TYPE.test(contentType))
    return undefined;
  if (bytes.includes(0)) return undefined;
  try {
    // `stream` tolerates a sequence cut by truncation at the very end.
    strictUtf8.decode(bytes, { stream: true });
  } catch {
    return undefined;
  }
  return utf8.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
}

export const isPseudoHeader = (name: string) => name.startsWith(":");

export function headerValue(headers: HeaderList, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

export function requestUrl(request: HttpRequestInput): string {
  const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
  return `${request.scheme}://${requestOrigin(request)}${path}`;
}

type Head = { readonly line: string; readonly headers: HeaderList };

const isHttp2Plus = (version: string) => /^HTTP\/[23]/i.test(version);

function requestHead(request: HttpRequestInput): Head {
  const method = headerValue(request.headers, ":method") ?? request.method;
  const path = headerValue(request.headers, ":path") ?? request.path;
  const authority = headerValue(request.headers, ":authority") ?? requestOrigin(request);
  const hasPseudo = request.headers.some(([name]) => isPseudoHeader(name));
  const headers = request.headers.filter(([name]) => !isPseudoHeader(name));
  const target = method.toUpperCase() === "CONNECT" ? authority : path;
  const withHost =
    (hasPseudo || isHttp2Plus(request.httpVersion)) && headerValue(headers, "host") === undefined
      ? [["Host", authority] as const, ...headers]
      : headers;
  return { line: `${method} ${target} ${request.httpVersion}`, headers: withHost };
}

function responseHead(response: HttpResponseInput): Head {
  const status = headerValue(response.headers, ":status") ?? String(response.status);
  const reason = response.reason ? ` ${response.reason}` : "";
  return {
    line: `${response.httpVersion} ${status}${reason}`,
    headers: response.headers.filter(([name]) => !isPseudoHeader(name)),
  };
}

function bodyNote(body: BodyInput) {
  if (!body.truncated) return "";
  const total = body.declaredBytes === undefined ? "" : ` of ${body.declaredBytes}`;
  return `\n[truncated: ${body.bytes.length}${total} bytes captured]`;
}

const headLines = (head: Head, eol: string) =>
  [head.line, ...head.headers.map(([name, value]) => `${name}: ${value}`)].join(eol);

function textMessage(head: Head, body: BodyInput | undefined, options: RawTextOptions | undefined) {
  const text = headLines(head, "\n");
  if (body === undefined || body.bytes.length === 0 || options?.includeBody === false) return text;
  const content = bodyText(body.bytes, body.contentType) ?? `[${body.bytes.length} bytes binary]`;
  return `${text}\n\n${content}${bodyNote(body)}`;
}

function bytesMessage(head: Head, body: BodyInput | undefined) {
  const headBytes = latin1Bytes(`${headLines(head, "\r\n")}\r\n\r\n`);
  const bodyBytes = body?.bytes ?? new Uint8Array();
  const out = new Uint8Array(headBytes.length + bodyBytes.length);
  out.set(headBytes);
  out.set(bodyBytes, headBytes.length);
  return out;
}

/** Readable request text with `\n` line ends; binary bodies become `[N bytes binary]`. */
export const rawRequest = (request: HttpRequestInput, options?: RawTextOptions) =>
  textMessage(requestHead(request), request.body, options);

export const rawResponse = (response: HttpResponseInput, options?: RawTextOptions) =>
  textMessage(responseHead(response), response.body, options);

/** The request as wire bytes: CRLF line ends and the captured body bytes. */
export const rawRequestBytes = (request: HttpRequestInput) =>
  bytesMessage(requestHead(request), request.body);

export const rawResponseBytes = (response: HttpResponseInput) =>
  bytesMessage(responseHead(response), response.body);
