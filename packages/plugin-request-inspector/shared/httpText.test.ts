import { describe, expect, it } from "vite-plus/test";

import {
  base64ToBytes,
  bodyText,
  bytesToBase64,
  type HttpRequestInput,
  rawRequest,
  rawRequestBytes,
  rawResponse,
  requestUrl,
} from "./httpText.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const request = (overrides: Partial<HttpRequestInput> = {}): HttpRequestInput => ({
  method: "POST",
  scheme: "https",
  host: "api.example.com",
  port: 443,
  authority: "api.example.com",
  path: "/v1/items?x=1",
  httpVersion: "HTTP/1.1",
  headers: [
    ["Host", "api.example.com"],
    ["Accept", "a/b"],
    ["X-Dup", "1"],
    ["x-dup", "2"],
  ],
  ...overrides,
});

describe("rawRequest", () => {
  it.each([
    {
      name: "keeps header order and duplicates",
      input: request(),
      expected:
        "POST /v1/items?x=1 HTTP/1.1\nHost: api.example.com\nAccept: a/b\nX-Dup: 1\nx-dup: 2",
    },
    {
      name: "appends a text body",
      input: request({
        headers: [],
        body: { bytes: encode('{"a":1}'), contentType: "application/json" },
      }),
      expected: 'POST /v1/items?x=1 HTTP/1.1\n\n{"a":1}',
    },
    {
      name: "replaces a binary body",
      input: request({ headers: [], body: { bytes: new Uint8Array([0, 1, 2]) } }),
      expected: "POST /v1/items?x=1 HTTP/1.1\n\n[3 bytes binary]",
    },
    {
      name: "treats a non-text content type as binary",
      input: request({ headers: [], body: { bytes: encode("PNG"), contentType: "image/png" } }),
      expected: "POST /v1/items?x=1 HTTP/1.1\n\n[3 bytes binary]",
    },
    {
      name: "notes truncation",
      input: request({
        headers: [],
        body: { bytes: encode("abc"), truncated: true, declaredBytes: 10 },
      }),
      expected: "POST /v1/items?x=1 HTTP/1.1\n\nabc\n[truncated: 3 of 10 bytes captured]",
    },
    {
      name: "maps HTTP/2 pseudo-headers to a request line and Host",
      input: request({
        method: "GET",
        httpVersion: "HTTP/2.0",
        headers: [
          [":method", "GET"],
          [":scheme", "https"],
          [":authority", "h2.example.com"],
          [":path", "/h2"],
          ["accept", "*/*"],
        ],
      }),
      expected: "GET /h2 HTTP/2.0\nHost: h2.example.com\naccept: */*",
    },
    {
      name: "adds Host to HTTP/2 without pseudo-headers",
      input: request({ method: "GET", httpVersion: "HTTP/2.0", headers: [["accept", "*/*"]] }),
      expected: "GET /v1/items?x=1 HTTP/2.0\nHost: api.example.com\naccept: */*",
    },
    {
      name: "uses the authority as a CONNECT target",
      input: request({ method: "CONNECT", authority: "", port: 8443, headers: [] }),
      expected: "CONNECT api.example.com:8443 HTTP/1.1",
    },
  ])("$name", ({ input, expected }) => {
    expect(rawRequest(input)).toBe(expected);
  });

  it("omits the body when asked", () => {
    const input = request({ headers: [], body: { bytes: encode("abc") } });
    expect(rawRequest(input, { includeBody: false })).toBe("POST /v1/items?x=1 HTTP/1.1");
  });
});

describe("rawResponse", () => {
  it.each([
    {
      name: "keeps duplicate Set-Cookie headers",
      input: {
        status: 200,
        reason: "OK",
        httpVersion: "HTTP/1.1",
        headers: [
          ["Set-Cookie", "a=1"],
          ["Set-Cookie", "b=2"],
        ] as const,
        body: { bytes: encode("ok"), contentType: "text/plain" },
      },
      expected: "HTTP/1.1 200 OK\nSet-Cookie: a=1\nSet-Cookie: b=2\n\nok",
    },
    {
      name: "drops :status and has no reason on HTTP/2",
      input: { status: 204, httpVersion: "HTTP/2.0", headers: [[":status", "204"]] as const },
      expected: "HTTP/2.0 204",
    },
  ])("$name", ({ input, expected }) => {
    expect(rawResponse(input)).toBe(expected);
  });
});

describe("rawRequestBytes", () => {
  it("uses CRLF, latin1 header bytes and the exact body bytes", () => {
    const bytes = rawRequestBytes(
      request({ headers: [["X-L", "é"]], body: { bytes: new Uint8Array([0, 255]) } }),
    );
    expect([...bytes]).toEqual([
      ...encode("POST /v1/items?x=1 HTTP/1.1\r\nX-L: "),
      0xe9,
      ...encode("\r\n\r\n"),
      0,
      255,
    ]);
  });
});

describe("helpers", () => {
  it("round-trips base64 for every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("tolerates a UTF-8 sequence cut at the end", () => {
    expect(bodyText(encode("é").subarray(0, 1))).toBe("�");
  });

  it.each([
    { input: request(), expected: "https://api.example.com/v1/items?x=1" },
    {
      input: request({ authority: "", port: 8443 }),
      expected: "https://api.example.com:8443/v1/items?x=1",
    },
    {
      input: request({ authority: "", host: "::1", scheme: "http", port: 80, path: "/" }),
      expected: "http://[::1]/",
    },
  ])("requestUrl $expected", ({ input, expected }) => {
    expect(requestUrl(input)).toBe(expected);
  });
});
