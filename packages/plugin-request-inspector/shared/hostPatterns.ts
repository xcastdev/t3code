export type HostPatternResult =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly reason: string };

const MAX_PATTERN_CHARS = 255;
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV6 = /^[0-9a-f:.]+$/;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitPort(pattern: string): { host: string; port?: string } | string {
  if (pattern.startsWith("[")) {
    const close = pattern.indexOf("]");
    if (close < 0) return "an IPv6 address needs a closing ]";
    const rest = pattern.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return "only :port may follow ]";
    return rest === ""
      ? { host: pattern.slice(0, close + 1) }
      : { host: pattern.slice(0, close + 1), port: rest.slice(1) };
  }
  const colon = pattern.indexOf(":");
  if (colon < 0) return { host: pattern };
  if (pattern.indexOf(":", colon + 1) >= 0) return "wrap an IPv6 address in [ ]";
  return { host: pattern.slice(0, colon), port: pattern.slice(colon + 1) };
}

/**
 * Compiles `example.com`, `*.example.com`, or `[::1]`, each with an optional `:port`, to an
 * anchored regex source for mitmproxy's `ignore_hosts`. mitmproxy searches it, case-insensitively,
 * against `host:port` strings built from the CONNECT address, the Host header, and the SNI.
 */
export function compileHostPattern(input: string): HostPatternResult {
  const pattern = input.trim().toLowerCase();
  if (pattern === "") return { ok: false, reason: "the pattern is empty" };
  if (pattern.length > MAX_PATTERN_CHARS)
    return { ok: false, reason: `the pattern is longer than ${MAX_PATTERN_CHARS} characters` };
  if (pattern.includes("/")) return { ok: false, reason: "give a host, not a URL or path" };
  const split = splitPort(pattern);
  if (typeof split === "string") return { ok: false, reason: split };
  let portSource = "\\d+";
  if (split.port !== undefined) {
    const port = Number(split.port);
    if (!/^\d{1,5}$/.test(split.port) || port < 1 || port > 65535)
      return { ok: false, reason: "the port must be a number from 1 to 65535" };
    portSource = String(port);
  }
  if (split.host.startsWith("[")) {
    const address = split.host.slice(1, -1);
    if (!IPV6.test(address) || !address.includes(":"))
      return { ok: false, reason: "the bracketed host is not an IPv6 address" };
    // mitmproxy formats peer addresses without brackets and Host headers with them.
    const escaped = escapeRegex(address);
    return { ok: true, source: `^(?:${escaped}|\\[${escaped}\\]):${portSource}$` };
  }
  const wildcard = split.host.startsWith("*.");
  const host = wildcard ? split.host.slice(2) : split.host;
  if (host.includes("*"))
    return { ok: false, reason: "a wildcard is allowed only as a leading *. label" };
  const labels = host.split(".");
  if (!labels.every((label) => LABEL.test(label)))
    return { ok: false, reason: `"${host}" is not a valid host name` };
  const prefix = wildcard ? "(?:[a-z0-9_-]+\\.)+" : "";
  return { ok: true, source: `^${prefix}${escapeRegex(host)}:${portSource}$` };
}

/** Mirrors mitmproxy's check for one `host:port`; invalid patterns never match. */
export function matchHost(patterns: ReadonlyArray<string>, host: string, port: number): boolean {
  const target = `${host}:${port}`;
  return patterns.some((pattern) => {
    const compiled = compileHostPattern(pattern);
    return compiled.ok && new RegExp(compiled.source, "i").test(target);
  });
}
