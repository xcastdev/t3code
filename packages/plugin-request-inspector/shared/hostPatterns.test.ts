import { describe, expect, it } from "vite-plus/test";

import { compileHostPattern, matchHost } from "./hostPatterns.ts";

describe("matchHost", () => {
  it.each([
    { pattern: "example.com", host: "example.com", port: 443, matches: true },
    { pattern: "Example.COM", host: "EXAMPLE.com", port: 80, matches: true },
    { pattern: "example.com", host: "api.example.com", port: 443, matches: false },
    { pattern: "example.com", host: "badexample.com", port: 443, matches: false },
    { pattern: "example.com", host: "example.com.evil.io", port: 443, matches: false },
    { pattern: "*.a.com", host: "a.com", port: 443, matches: false },
    { pattern: "*.a.com", host: "x.a.com", port: 443, matches: true },
    { pattern: "*.a.com", host: "x.y.a.com", port: 443, matches: true },
    { pattern: "*.a.com", host: "xa.com", port: 443, matches: false },
    { pattern: "example.com:8443", host: "example.com", port: 8443, matches: true },
    { pattern: "example.com:8443", host: "example.com", port: 443, matches: false },
    { pattern: "*.a.com:443", host: "x.a.com", port: 80, matches: false },
    { pattern: "10.0.0.1", host: "10.0.0.1", port: 22, matches: true },
    { pattern: "10.0.0.1", host: "10.0.0.11", port: 22, matches: false },
    { pattern: "[::1]:443", host: "::1", port: 443, matches: true },
    { pattern: "[::1]:443", host: "[::1]", port: 443, matches: true },
    { pattern: "[::1]", host: "::1", port: 8080, matches: true },
  ])("$pattern vs $host:$port → $matches", ({ pattern, host, port, matches }) => {
    expect(matchHost([pattern], host, port)).toBe(matches);
  });

  it("ignores invalid patterns and matches any valid one", () => {
    expect(matchHost(["http://a.com", "b.com"], "b.com", 443)).toBe(true);
    expect(matchHost(["http://a.com"], "a.com", 443)).toBe(false);
  });
});

describe("compileHostPattern", () => {
  it("emits an anchored source that mitmproxy can use", () => {
    expect(compileHostPattern(" *.Example.com ")).toEqual({
      ok: true,
      source: "^(?:[a-z0-9_-]+\\.)+example\\.com:\\d+$",
    });
    expect(compileHostPattern("example.com:8443")).toEqual({
      ok: true,
      source: "^example\\.com:8443$",
    });
  });

  it.each([
    { pattern: "", reason: "the pattern is empty" },
    { pattern: "https://a.com", reason: "give a host, not a URL or path" },
    { pattern: "a.com/x", reason: "give a host, not a URL or path" },
    { pattern: "*.", reason: '"" is not a valid host name' },
    { pattern: "*", reason: "a wildcard is allowed only as a leading *. label" },
    { pattern: "a.*.com", reason: "a wildcard is allowed only as a leading *. label" },
    { pattern: "*a.com", reason: "a wildcard is allowed only as a leading *. label" },
    { pattern: "a.com:0", reason: "the port must be a number from 1 to 65535" },
    { pattern: "a.com:70000", reason: "the port must be a number from 1 to 65535" },
    { pattern: "a.com:", reason: "the port must be a number from 1 to 65535" },
    { pattern: "a..com", reason: '"a..com" is not a valid host name' },
    { pattern: "-a.com", reason: '"-a.com" is not a valid host name' },
    { pattern: "::1", reason: "wrap an IPv6 address in [ ]" },
    { pattern: "[::1", reason: "an IPv6 address needs a closing ]" },
    { pattern: "[zz]", reason: "the bracketed host is not an IPv6 address" },
    { pattern: `${"a".repeat(256)}`, reason: "the pattern is longer than 255 characters" },
  ])("rejects $pattern", ({ pattern, reason }) => {
    expect(compileHostPattern(pattern)).toEqual({ ok: false, reason });
  });
});
