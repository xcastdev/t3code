import { describe, expect, it } from "vite-plus/test";

import {
  defaultCookiePath,
  type FormatHeadersInput,
  formatHeaders,
  parseSetCookie,
  shellQuote,
} from "./headerFormats.ts";

const requestSide = (overrides: Partial<FormatHeadersInput>): FormatHeadersInput => ({
  side: "request",
  request: { host: "app.example.com", path: "/api/users?id=1" },
  headers: [
    [":authority", "app.example.com"],
    ["Accept", "*/*"],
    ["Cookie", "sid=s3cret; theme=dark"],
    ["X-Dup", "1"],
    ["X-Dup", "2"],
    ["Authorization", "Bearer t0ken"],
  ],
  format: "raw",
  ...overrides,
});

const responseSide = (overrides: Partial<FormatHeadersInput>): FormatHeadersInput => ({
  side: "response",
  request: { host: "app.example.com", path: "/api/users" },
  capturedAt: 1_700_000_000_000,
  headers: [
    ["Content-Type", "text/html"],
    ["Set-Cookie", "sid=s3cret; Path=/; Secure; HttpOnly"],
    ["Set-Cookie", "theme=dark; Domain=.Example.com; Max-Age=60"],
    ["Set-Cookie", "old=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT"],
  ],
  format: "raw",
  ...overrides,
});

describe("formatHeaders", () => {
  it.each([
    {
      name: "raw keeps order and duplicates and drops pseudo-headers",
      input: requestSide({}),
      expected:
        "Accept: */*\nCookie: sid=s3cret; theme=dark\nX-Dup: 1\nX-Dup: 2\nAuthorization: Bearer t0ken",
    },
    {
      name: "names select case-insensitively",
      input: requestSide({ names: ["x-dup"] }),
      expected: "X-Dup: 1\nX-Dup: 2",
    },
    {
      name: "a cookie list narrows the Cookie header",
      input: requestSide({ names: ["cookie"], cookies: ["theme"] }),
      expected: "Cookie: theme=dark",
    },
    {
      name: "cookies: false drops the cookie header",
      input: requestSide({ names: ["cookie", "accept"], cookies: false }),
      expected: "Accept: */*",
    },
    {
      name: "a cookie list narrows Set-Cookie headers",
      input: responseSide({ cookies: ["theme"], names: ["set-cookie"] }),
      expected: "Set-Cookie: theme=dark; Domain=.Example.com; Max-Age=60",
    },
    {
      name: "json is an ordered name/value list",
      input: requestSide({ format: "json", names: ["x-dup"] }),
      expected:
        '[\n  {\n    "name": "X-Dup",\n    "value": "1"\n  },\n  {\n    "name": "X-Dup",\n    "value": "2"\n  }\n]',
    },
    {
      name: "curl quotes each header",
      input: requestSide({ format: "curl", names: ["accept", "cookie"], cookies: ["sid"] }),
      expected: "-H 'Accept: */*' \\\n-H 'Cookie: sid=s3cret'",
    },
    {
      name: "js keeps duplicates in a Headers list",
      input: requestSide({ format: "js", names: ["x-dup"] }),
      expected: 'const headers = new Headers([\n  ["X-Dup", "1"],\n  ["X-Dup", "2"],\n]);',
    },
    {
      name: "python merges duplicates, cookies with ;",
      input: requestSide({
        format: "python",
        names: ["x-dup", "cookie"],
        headers: [
          ["X-Dup", "1"],
          ["Cookie", "a=1"],
          ["x-dup", "2"],
          ["cookie", "b=2"],
        ],
      }),
      expected: 'headers = {\n    "X-Dup": "1, 2",\n    "Cookie": "a=1; b=2",\n}',
    },
    {
      name: "cookie-header from a request",
      input: requestSide({ format: "cookie-header" }),
      expected: "sid=s3cret; theme=dark",
    },
    {
      name: "cookie-header from Set-Cookie",
      input: responseSide({ format: "cookie-header", cookies: ["sid", "theme"] }),
      expected: "sid=s3cret; theme=dark",
    },
    {
      name: "netscape rows for request cookies use the host and default path",
      input: requestSide({ format: "netscape" }),
      expected:
        "# Netscape HTTP Cookie File\napp.example.com\tFALSE\t/api\tFALSE\t0\tsid\ts3cret\napp.example.com\tFALSE\t/api\tFALSE\t0\ttheme\tdark",
    },
    {
      name: "netscape rows honour Set-Cookie attributes",
      input: responseSide({ format: "netscape" }),
      expected: [
        "# Netscape HTTP Cookie File",
        "#HttpOnly_app.example.com\tFALSE\t/\tTRUE\t0\tsid\ts3cret",
        ".example.com\tTRUE\t/api\tFALSE\t1700000060\ttheme\tdark",
        "app.example.com\tFALSE\t/api\tFALSE\t1445412480\told\t1",
      ].join("\n"),
    },
  ])("$name", ({ input, expected }) => {
    expect(formatHeaders(input)).toBe(expected);
  });
});

describe("parseSetCookie", () => {
  it("reads attributes case-insensitively and ignores unknown ones", () => {
    expect(parseSetCookie("a=b=c; DOMAIN=X.com; path=/p; SameSite=Lax; Partitioned")).toEqual({
      name: "a",
      value: "b=c",
      domain: "x.com",
      path: "/p",
      sameSite: "Lax",
      secure: false,
      httpOnly: false,
    });
  });
});

describe("defaultCookiePath", () => {
  it.each([
    ["/", "/"],
    ["/a", "/"],
    ["/a/b", "/a"],
    ["/a/b/?q=/x", "/a/b"],
    ["", "/"],
  ])("%s → %s", (path, expected) => {
    expect(defaultCookiePath(path)).toBe(expected);
  });
});

describe("shellQuote", () => {
  it.each([
    ["plain", "'plain'"],
    ["it's", "'it'\\''s'"],
    ["a\nb's\\", "$'a\\nb\\'s\\\\'"],
    ["\u0001", "$'\\x01'"],
  ])("%j", (text, expected) => {
    expect(shellQuote(text)).toBe(expected);
  });
});
