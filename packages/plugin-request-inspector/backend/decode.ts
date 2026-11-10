// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

const KiB = 1024;
const MiB = 1024 * KiB;

export const DECODE_LIMITS = {
  maxSteps: 16,
  maxInputBytes: 1 * MiB,
  maxStepOutputBytes: 4 * MiB,
  maxTextPreviewBytes: 64 * KiB,
  maxBase64PreviewChars: 64 * KiB,
  maxKeyChars: 1024,
} as const;

export const DECODE_OPS = [
  "base64",
  "base64url",
  "url",
  "hex",
  "html",
  "unicode",
  "gzip",
  "deflate",
  "brotli",
  "jwt",
  "json",
  "hash",
  "aes",
  "xor",
] as const;
export type DecodeOp = (typeof DECODE_OPS)[number];

const ENCODABLE_OPS: ReadonlySet<DecodeOp> = new Set([
  "base64",
  "base64url",
  "url",
  "hex",
  "html",
  "unicode",
  "gzip",
  "deflate",
  "brotli",
]);
const HASH_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
const AES_MODES = ["cbc", "gcm", "ctr"] as const;
const KEY_ENCODINGS = ["hex", "base64", "utf8"] as const;

export type KeyEncoding = (typeof KEY_ENCODINGS)[number];

export interface DecodeStep {
  op: DecodeOp;
  direction?: "decode" | "encode";
  algorithm?: (typeof HASH_ALGORITHMS)[number];
  aes?: {
    mode: (typeof AES_MODES)[number];
    key: string;
    iv: string;
    tag?: string;
    encoding: KeyEncoding;
  };
  xor?: { key: string; encoding: KeyEncoding };
}

export interface DecodeStepResult {
  op: DecodeOp;
  ok: boolean;
  bytes: number;
  isText: boolean;
  text?: string;
  base64?: string;
  truncated?: true;
  error?: string;
}

export interface DecodeResult {
  steps: DecodeStepResult[];
  error?: string;
}

class StepError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const isKeyString = (value: unknown): value is string =>
  typeof value === "string" && value.length <= DECODE_LIMITS.maxKeyChars;

function parseStep(raw: unknown, index: number): DecodeStep | string {
  const at = `steps[${index}]`;
  if (!isRecord(raw)) return `${at} must be an object`;
  const { op, direction } = raw;
  if (!isOneOf(DECODE_OPS, op)) return `${at}.op must be one of ${DECODE_OPS.join(", ")}`;
  if (direction !== undefined && direction !== "decode" && direction !== "encode") {
    return `${at}.direction must be "decode" or "encode"`;
  }
  if (direction === "encode" && !ENCODABLE_OPS.has(op))
    return `${at}: ${op} has no encode direction`;
  const step: DecodeStep = direction === undefined ? { op } : { op, direction };
  if (op === "hash") {
    if (!isOneOf(HASH_ALGORITHMS, raw.algorithm)) {
      return `${at}.algorithm must be one of ${HASH_ALGORITHMS.join(", ")}`;
    }
    step.algorithm = raw.algorithm;
  }
  if (op === "aes") {
    const aes = raw.aes;
    if (!isRecord(aes)) return `${at}.aes is required`;
    if (!isOneOf(AES_MODES, aes.mode))
      return `${at}.aes.mode must be one of ${AES_MODES.join(", ")}`;
    if (!isOneOf(KEY_ENCODINGS, aes.encoding)) {
      return `${at}.aes.encoding must be one of ${KEY_ENCODINGS.join(", ")}`;
    }
    if (!isKeyString(aes.key)) return `${at}.aes.key must be a string`;
    if (!isKeyString(aes.iv)) return `${at}.aes.iv must be a string`;
    if (aes.tag !== undefined && !isKeyString(aes.tag)) return `${at}.aes.tag must be a string`;
    if (aes.mode === "gcm" && aes.tag === undefined) return `${at}.aes.tag is required for gcm`;
    step.aes = { mode: aes.mode, key: aes.key, iv: aes.iv, encoding: aes.encoding };
    if (aes.tag !== undefined) step.aes.tag = aes.tag;
  }
  if (op === "xor") {
    const xor = raw.xor;
    if (!isRecord(xor)) return `${at}.xor is required`;
    if (!isOneOf(KEY_ENCODINGS, xor.encoding)) {
      return `${at}.xor.encoding must be one of ${KEY_ENCODINGS.join(", ")}`;
    }
    if (!isKeyString(xor.key) || xor.key.length === 0)
      return `${at}.xor.key must be a non-empty string`;
    step.xor = { key: xor.key, encoding: xor.encoding };
  }
  return step;
}

export function parseDecodeSteps(
  raw: unknown,
): { ok: true; steps: DecodeStep[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "steps must be an array" };
  if (raw.length > DECODE_LIMITS.maxSteps) {
    return { ok: false, reason: `steps must have at most ${DECODE_LIMITS.maxSteps} entries` };
  }
  const steps: DecodeStep[] = [];
  for (const [index, entry] of raw.entries()) {
    const step = parseStep(entry, index);
    if (typeof step === "string") return { ok: false, reason: step };
    steps.push(step);
  }
  return { ok: true, steps };
}

const utf8Fatal = new TextDecoder("utf-8", { fatal: true });
const utf8Lenient = new TextDecoder("utf-8");

function asUtf8(input: Buffer, op: string): string {
  try {
    return utf8Fatal.decode(input);
  } catch {
    throw new StepError(`${op} input is not UTF-8 text`);
  }
}

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");

function decodeBase64Text(text: string, urlSafe: boolean, what: string): Buffer {
  const compact = text.replace(/\s+/g, "");
  const alphabet = urlSafe ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/_-]*={0,2}$/;
  if (!alphabet.test(compact) || compact.replace(/=+$/, "").length % 4 === 1) {
    throw new StepError(`${what} is not valid ${urlSafe ? "base64url" : "base64"}`);
  }
  return Buffer.from(compact, urlSafe ? "base64url" : "base64");
}

function decodeHexText(text: string, what: string): Buffer {
  const compact = text.replace(/[\s:]+/g, "").replace(/^0x/i, "");
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) {
    throw new StepError(`${what} is not valid hex`);
  }
  return Buffer.from(compact, "hex");
}

function decodeKey(value: string, encoding: KeyEncoding, what: string): Buffer {
  if (encoding === "utf8") return utf8(value);
  return encoding === "hex" ? decodeHexText(value, what) : decodeBase64Text(value, false, what);
}

const isUnreserved = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2d ||
  byte === 0x2e ||
  byte === 0x5f ||
  byte === 0x7e;

const hexValue = (byte: number) => {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  const lower = byte | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
};

// Byte-level so %FF and other non-UTF-8 escapes survive; "+" is a space as in form bodies.
function urlDecode(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let length = 0;
  for (let index = 0; index < input.length; index++) {
    const byte = input[index]!;
    if (byte === 0x25 && index + 2 < input.length) {
      const high = hexValue(input[index + 1]!);
      const low = hexValue(input[index + 2]!);
      if (high >= 0 && low >= 0) {
        out[length++] = (high << 4) | low;
        index += 2;
        continue;
      }
    }
    out[length++] = byte === 0x2b ? 0x20 : byte;
  }
  return out.subarray(0, length);
}

function urlEncode(input: Buffer): Buffer {
  let text = "";
  for (const byte of input) {
    text += isUnreserved(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return utf8(text);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  divide: "÷",
  euro: "€",
  cent: "¢",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
};

const codePointOrReplacement = (value: number) =>
  Number.isFinite(value) && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : "�";

function htmlDecode(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      return codePointOrReplacement(Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10));
    }
    return HTML_ENTITIES[body] ?? match;
  });
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const htmlEncode = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);

// \xHH is a raw byte (Python byte reprs) while \u escapes are code points, so output is bytes.
function unicodeDecode(text: string): Buffer {
  const parts: Buffer[] = [];
  const pattern =
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(utf8(text.slice(last, match.index)));
    last = match.index + match[0].length;
    const [, braced, high, low, unit, byte] = match;
    if (braced !== undefined) {
      parts.push(utf8(codePointOrReplacement(Number.parseInt(braced, 16))));
    } else if (high !== undefined && low !== undefined) {
      parts.push(utf8(String.fromCharCode(Number.parseInt(high, 16), Number.parseInt(low, 16))));
    } else if (unit !== undefined) {
      parts.push(utf8(codePointOrReplacement(Number.parseInt(unit, 16))));
    } else if (byte !== undefined) {
      parts.push(Buffer.from([Number.parseInt(byte, 16)]));
    }
  }
  parts.push(utf8(text.slice(last)));
  return Buffer.concat(parts);
}

function unicodeEncode(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    out += unit >= 0x20 && unit < 0x7f ? text[index] : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return out;
}

// Reindents the original tokens instead of re-serializing, so big integers keep their digits.
function prettyJson(text: string): string {
  const source = text.replace(/^﻿/, "");
  try {
    JSON.parse(source);
  } catch (error) {
    throw new StepError(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  let out = "";
  let depth = 0;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === '"') {
      let end = index + 1;
      while (source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      out += source.slice(index, end + 1);
      index = end;
    } else if (char === "{" || char === "[") {
      const close = char === "{" ? "}" : "]";
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (source[next] === close) {
        out += char + close;
        index = next;
      } else {
        depth++;
        out += char + newline();
      }
    } else if (char === "}" || char === "]") {
      depth--;
      out += newline() + char;
    } else if (char === ",") {
      out += `,${newline()}`;
    } else if (char === ":") {
      out += ": ";
    } else if (!/\s/.test(char)) {
      out += char;
    }
  }
  return out;
}

function decodeJwt(text: string): string {
  const parts = text.trim().split(".");
  if (parts.length === 5) throw new StepError("JWE tokens are encrypted and cannot be decoded");
  if (parts.length !== 3) throw new StepError("JWT must have 3 dot-separated parts");
  const [headerPart, payloadPart, signature] = parts as [string, string, string];
  const decodePart = (part: string, name: string): unknown => {
    const bytes = decodeBase64Text(part, true, `JWT ${name}`);
    try {
      return JSON.parse(utf8Fatal.decode(bytes));
    } catch {
      throw new StepError(`JWT ${name} is not JSON`);
    }
  };
  const decoded = {
    header: decodePart(headerPart, "header"),
    payload: decodePart(payloadPart, "payload"),
    signature,
  };
  return JSON.stringify(decoded, null, 2);
}

function aesDecrypt(input: Buffer, options: NonNullable<DecodeStep["aes"]>): Buffer {
  const key = decodeKey(options.key, options.encoding, "AES key");
  const iv = decodeKey(options.iv, options.encoding, "AES iv");
  if (![16, 24, 32].includes(key.length)) {
    throw new StepError(`AES key must be 16, 24, or 32 bytes (got ${key.length})`);
  }
  const cipher = `aes-${key.length * 8}-${options.mode}`;
  try {
    if (options.mode === "gcm") {
      if (options.tag === undefined) throw new StepError("AES-GCM needs a tag");
      const tag = decodeKey(options.tag, options.encoding, "AES tag");
      if (iv.length === 0) throw new StepError("AES-GCM iv must not be empty");
      const decipher = NodeCrypto.createDecipheriv(cipher as NodeCrypto.CipherGCMTypes, key, iv, {
        authTagLength: tag.length,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(input), decipher.final()]);
    }
    if (iv.length !== 16)
      throw new StepError(
        `AES-${options.mode.toUpperCase()} iv must be 16 bytes (got ${iv.length})`,
      );
    const decipher = NodeCrypto.createDecipheriv(cipher, key, iv);
    return Buffer.concat([decipher.update(input), decipher.final()]);
  } catch (error) {
    if (error instanceof StepError) throw error;
    if (options.mode === "gcm")
      throw new StepError("AES-GCM authentication failed (wrong key, iv, or tag)");
    throw new StepError(
      `AES decryption failed (wrong key, iv, or padding): ${errorMessage(error)}`,
    );
  }
}

function xorBytes(input: Buffer, options: NonNullable<DecodeStep["xor"]>): Buffer {
  const key = decodeKey(options.key, options.encoding, "XOR key");
  if (key.length === 0) throw new StepError("XOR key must not be empty");
  const out = Buffer.allocUnsafe(input.length);
  for (let index = 0; index < input.length; index++)
    out[index] = input[index]! ^ key[index % key.length]!;
  return out;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isZlibSizeError = (error: unknown) =>
  error instanceof RangeError ||
  (error as { code?: unknown } | null)?.code === "ERR_BUFFER_TOO_LARGE";

function inflate(
  input: Buffer,
  what: string,
  run: (options: NodeZlib.ZlibOptions) => Buffer,
): Buffer {
  try {
    return run({ maxOutputLength: DECODE_LIMITS.maxStepOutputBytes });
  } catch (error) {
    if (isZlibSizeError(error)) throw sizeError();
    throw new StepError(`not ${what} data (${errorMessage(error)})`);
  }
}

const sizeError = () =>
  new StepError(`output exceeds ${DECODE_LIMITS.maxStepOutputBytes / MiB} MiB`);

function runStep(input: Buffer, step: DecodeStep): Buffer {
  const encode = step.direction === "encode";
  if (encode && !ENCODABLE_OPS.has(step.op))
    throw new StepError(`${step.op} has no encode direction`);
  switch (step.op) {
    case "base64":
    case "base64url": {
      const urlSafe = step.op === "base64url";
      if (encode) return utf8(input.toString(urlSafe ? "base64url" : "base64"));
      return decodeBase64Text(input.toString("latin1"), urlSafe, "input");
    }
    case "hex":
      return encode
        ? utf8(input.toString("hex"))
        : decodeHexText(input.toString("latin1"), "input");
    case "url":
      return encode ? urlEncode(input) : urlDecode(input);
    case "html": {
      const text = asUtf8(input, "html");
      return utf8(encode ? htmlEncode(text) : htmlDecode(text));
    }
    case "unicode": {
      const text = asUtf8(input, "unicode");
      return encode ? utf8(unicodeEncode(text)) : unicodeDecode(text);
    }
    case "gzip":
      if (encode) return NodeZlib.gzipSync(input);
      return inflate(input, "gzip", (options) => NodeZlib.gunzipSync(input, options));
    case "deflate":
      if (encode) return NodeZlib.deflateSync(input);
      try {
        return NodeZlib.inflateSync(input, { maxOutputLength: DECODE_LIMITS.maxStepOutputBytes });
      } catch (error) {
        if (isZlibSizeError(error)) throw sizeError();
        return inflate(input, "deflate", (options) => NodeZlib.inflateRawSync(input, options));
      }
    case "brotli":
      if (encode) return NodeZlib.brotliCompressSync(input);
      return inflate(input, "brotli", (options) => NodeZlib.brotliDecompressSync(input, options));
    case "jwt":
      return utf8(decodeJwt(asUtf8(input, "jwt")));
    case "json":
      return utf8(prettyJson(asUtf8(input, "json")));
    case "hash":
      if (step.algorithm === undefined) throw new StepError("hash needs an algorithm");
      return utf8(NodeCrypto.createHash(step.algorithm).update(input).digest("hex"));
    case "aes":
      if (step.aes === undefined) throw new StepError("aes needs key options");
      return aesDecrypt(input, step.aes);
    case "xor":
      if (step.xor === undefined) throw new StepError("xor needs a key");
      return xorBytes(input, step.xor);
  }
}

function isTextBytes(bytes: Buffer): boolean {
  let text: string;
  try {
    text = utf8Fatal.decode(bytes);
  } catch {
    return false;
  }
  // Tab, LF, and CR are fine; other C0 controls and DEL mark binary data.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

function describeOutput(op: DecodeOp, bytes: Buffer): DecodeStepResult {
  const result: DecodeStepResult = {
    op,
    ok: true,
    bytes: bytes.length,
    isText: isTextBytes(bytes),
  };
  if (result.isText) {
    let cut = Math.min(bytes.length, DECODE_LIMITS.maxTextPreviewBytes);
    while (cut < bytes.length && cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
    result.text = utf8Lenient.decode(bytes.subarray(0, cut));
    if (cut < bytes.length) result.truncated = true;
  } else {
    const maxBytes = (DECODE_LIMITS.maxBase64PreviewChars / 4) * 3;
    result.base64 = bytes.subarray(0, maxBytes).toString("base64");
    if (bytes.length > maxBytes) result.truncated = true;
  }
  return result;
}

export function decodeChain(source: Uint8Array, steps: readonly DecodeStep[]): DecodeResult {
  if (source.length > DECODE_LIMITS.maxInputBytes) {
    return { steps: [], error: `input exceeds ${DECODE_LIMITS.maxInputBytes / MiB} MiB` };
  }
  if (steps.length > DECODE_LIMITS.maxSteps) {
    return { steps: [], error: `at most ${DECODE_LIMITS.maxSteps} steps are allowed` };
  }
  const results: DecodeStepResult[] = [];
  let current = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  for (const step of steps) {
    let output: Buffer;
    try {
      output = runStep(current, step);
      if (output.length > DECODE_LIMITS.maxStepOutputBytes) throw sizeError();
    } catch (error) {
      const message =
        error instanceof StepError ? error.message : `${step.op} failed: ${errorMessage(error)}`;
      results.push({ op: step.op, ok: false, bytes: 0, isText: false, error: message });
      break;
    }
    results.push(describeOutput(step.op, output));
    current = output;
  }
  return { steps: results };
}
