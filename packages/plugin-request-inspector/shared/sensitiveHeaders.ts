import { parseCookieHeader } from "./headerFormats.ts";
import type { HeaderList } from "./httpText.ts";

/** Headers whose values are credentials. Agents and chat attachments see them redacted. */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-goog-api-key",
  "x-amz-security-token",
  "x-csrf-token",
  "x-honeycomb-team",
  "x-vercel-protection-bypass",
]);

// Whole `-`/`_`-separated words, so `x-ratelimit-remaining-tokens` and `:authority` stay visible.
// A final segment ending in `key` (`X-Master-Key`, `x-functions-key`) counts as a credential.
const SENSITIVE_HEADER_NAME =
  /(^|[-_])([a-z0-9]*token|[a-z0-9]*secret|[a-z0-9]*api[-_]?key|access[-_]key|subscription[-_]key|passw(or)?d|session|sessionid|signature|auth|authorization|authentication|credentials?|jwt|oidc)([-_]|$)|(^|[-_])[a-z0-9]*key$/i;

// Checked before the pattern: names it matches whose values are not credentials. Debug
// headers (CORS, pagination tokens, protocol nonces, oauth2-proxy identity) stay visible.
const NOT_SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "sec-websocket-key",
  "idempotency-key",
  "x-idempotency-key",
  "x-cache-key",
  "signature-input",
  "accept-signature",
  "x-token-count",
  "x-next-page-token",
  "x-continuation-token",
  "x-auth-request-email",
  "x-auth-request-user",
  "mcp-session-id",
]);
const NOT_SENSITIVE_HEADER_NAME = /^access-control-|[-_](timeout|affinity)$/i;

export const REDACTED_VALUE = "[redacted]";

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADERS.has(lower)) return true;
  if (NOT_SENSITIVE_HEADERS.has(lower) || NOT_SENSITIVE_HEADER_NAME.test(lower)) return false;
  return SENSITIVE_HEADER_NAME.test(lower);
}

const redactCookiePairs = (value: string) =>
  parseCookieHeader(value)
    .map(({ name }) => (name === "" ? REDACTED_VALUE : `${name}=${REDACTED_VALUE}`))
    .join("; ");

const redactSetCookie = (cookie: string) => {
  const semi = cookie.indexOf(";");
  return semi < 0
    ? redactCookiePairs(cookie)
    : `${redactCookiePairs(cookie.slice(0, semi))}${cookie.slice(semi)}`;
};

/** Cookie headers keep their cookie names (and Set-Cookie its attributes); other values are replaced. */
export function redactHeaderValue(name: string, value: string): string {
  switch (name.toLowerCase()) {
    case "cookie":
      return redactCookiePairs(value);
    case "set-cookie":
      // Some servers fold several cookies into one header; an Expires date's comma is never followed by `name=`.
      return value.split(/,\s*(?=[^;,=\s]+=)/).map(redactSetCookie).join(", ");
    default:
      return isSensitiveHeader(name) ? REDACTED_VALUE : value;
  }
}

export const redactHeaders = (headers: HeaderList): Array<[string, string]> =>
  headers.map(([name, value]) => [name, redactHeaderValue(name, value)]);

export interface RestoredHeaders {
  readonly headers: Array<[string, string]>;
  /** Credential headers whose `[redacted]` placeholders were dropped instead of restored. */
  readonly withheld: Array<string>;
}

/**
 * Puts recorded credential values back where an edited header list still carries the
 * `[redacted]` placeholder an agent read, so a replay does not send the placeholder upstream.
 * The nth same-name header (or cookie) takes the nth recorded value. With `restore` false
 * the placeholders are dropped instead, and their header names are listed in `withheld`.
 */
export function restoreRedactedHeaders(
  edited: HeaderList,
  recorded: HeaderList,
  restore = true,
): RestoredHeaders {
  // Keys are `header:<lowercase name>` and `cookie:<cookie name>`; values keep recorded order.
  const values = new Map<string, Array<string>>();
  const record = (key: string, value: string) => {
    const list = values.get(key);
    if (list === undefined) values.set(key, [value]);
    else list.push(value);
  };
  for (const [name, value] of recorded) {
    record(`header:${name.toLowerCase()}`, value);
    if (name.toLowerCase() !== "cookie") continue;
    for (const cookie of parseCookieHeader(value)) record(`cookie:${cookie.name}`, cookie.value);
  }
  const taken = new Map<string, number>();
  const take = (key: string) => {
    const index = taken.get(key) ?? 0;
    taken.set(key, index + 1);
    return values.get(key)?.[index];
  };
  const headers: Array<[string, string]> = [];
  const withheld: Array<string> = [];
  const withhold = (name: string) => {
    if (!withheld.some((seen) => seen.toLowerCase() === name.toLowerCase())) withheld.push(name);
  };

  for (const [name, value] of edited) {
    const lower = name.toLowerCase();
    if (!isSensitiveHeader(lower)) {
      headers.push([name, value]);
      continue;
    }
    const recordedValue = take(`header:${lower}`);
    if (lower !== "cookie") {
      if (value !== REDACTED_VALUE) headers.push([name, value]);
      else if (restore) headers.push([name, recordedValue ?? value]);
      else withhold(name);
      continue;
    }
    const cookies = parseCookieHeader(value);
    if (!value.includes(REDACTED_VALUE)) {
      for (const cookie of cookies) take(`cookie:${cookie.name}`);
      headers.push([name, value]);
      continue;
    }
    if (value === REDACTED_VALUE) {
      if (restore) headers.push([name, recordedValue ?? value]);
      else withhold(name);
      continue;
    }
    const parts: Array<string> = [];
    for (const cookie of cookies) {
      // Nameless entries share the `cookie:` key, so they also restore by position.
      const positional = take(`cookie:${cookie.name}`);
      const placeholder = cookie.value === REDACTED_VALUE;
      if (placeholder && !restore) {
        withhold(name);
        continue;
      }
      const restored = placeholder ? (positional ?? cookie.value) : cookie.value;
      parts.push(cookie.name === "" ? restored : `${cookie.name}=${restored}`);
    }
    if (parts.length > 0) headers.push([name, parts.join("; ")]);
  }
  return { headers, withheld };
}
