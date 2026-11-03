export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

export const REDACTED_VALUE = "[redacted]";

export const isSensitiveHeader = (name: string) => SENSITIVE_HEADER_NAMES.has(name.toLowerCase());

/** Hides credential header values, keeping names and order, unless they were asked for. */
export function redactHeaders(
  headers: ReadonlyArray<readonly [string, string]>,
  includeSensitive: boolean,
): Array<[string, string]> {
  return headers.map(([name, value]) => [
    name,
    !includeSensitive && isSensitiveHeader(name) ? REDACTED_VALUE : value,
  ]);
}
