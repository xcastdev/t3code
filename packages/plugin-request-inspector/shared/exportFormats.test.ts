import { describe, expect, it } from "vite-plus/test";

import { type ExportEntry, type ExportFormat, exportRequests } from "./exportFormats.ts";
import { base64ToBytes, type BodyInput, type HttpRequestInput } from "./httpText.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const creator = { name: "T3 Request Inspector", version: "0.2.0" };

const request = (overrides: Partial<HttpRequestInput> = {}): HttpRequestInput => ({
  method: "GET",
  scheme: "https",
  host: "api.example.com",
  port: 443,
  authority: "api.example.com",
  path: "/v1/items?q=a%20b&flag",
  httpVersion: "HTTP/1.1",
  headers: [
    ["Host", "api.example.com"],
    ["X-Dup", "1"],
    ["X-Dup", "2"],
  ],
  ...overrides,
});

const entry = (overrides: Partial<ExportEntry> = {}): ExportEntry => ({
  id: "7",
  flowType: "http",
  startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  endedAt: Date.UTC(2026, 0, 2, 3, 4, 5) + 120,
  request: request(),
  response: {
    status: 200,
    reason: "OK",
    httpVersion: "HTTP/1.1",
    headers: [
      ["Content-Type", "application/json"],
      ["Set-Cookie", "a=1"],
      ["Set-Cookie", "b=2"],
    ],
    body: { bytes: encode('{"ok":true}'), contentType: "application/json" },
  },
  ...overrides,
});

const tunnel: ExportEntry = {
  id: "8",
  flowType: "tunnel",
  startedAt: 0,
  endedAt: 50,
  request: request({ method: "CONNECT", path: "", headers: [] }),
  sni: "api.example.com",
  clientAddr: "127.0.0.1:5000",
  bytesUp: 10,
  bytesDown: 20,
};

const withCredentials = entry({
  request: request({
    method: "POST",
    headers: [
      ["Authorization", "Bearer t0ken"],
      ["Cookie", "sid=s3cret"],
      ["Proxy-Authorization", "Basic cHJveHk="],
    ],
    body: { bytes: encode("x=1"), contentType: "application/x-www-form-urlencoded" },
  }),
  response: {
    status: 200,
    httpVersion: "HTTP/1.1",
    headers: [["Set-Cookie", "sid=s3cret; Path=/"]],
  },
});

type HarJson = {
  log: {
    creator: typeof creator;
    entries: Array<{
      startedDateTime: string;
      time: number;
      timings: Record<string, number>;
      request: {
        headers: Array<{ name: string; value: string }>;
        queryString: unknown;
        cookies: unknown;
        postData?: { text: string; _encoding?: string };
      };
      response: {
        headers: Array<{ name: string; value: string }>;
        cookies: unknown;
        content: { size: number; text?: string; encoding?: string; compression?: number };
      };
    }>;
  };
};

const har = (entries: ExportEntry[]) =>
  JSON.parse(exportRequests(entries, { format: "har", creator }).text) as HarJson;

describe("exportRequests HAR", () => {
  it("writes HAR 1.2 metadata, timings, query and duplicate headers", () => {
    const log = har([entry()]).log;
    expect(log.creator).toEqual(creator);
    const [first] = log.entries;
    expect(first?.startedDateTime).toBe("2026-01-02T03:04:05.000Z");
    expect(first?.time).toBe(120);
    expect(first?.timings).toEqual({
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: 120,
      receive: 0,
    });
    expect(first?.request.queryString).toEqual([
      { name: "q", value: "a b" },
      { name: "flag", value: "" },
    ]);
    expect(first?.request.headers.filter((h) => h.name === "X-Dup").map((h) => h.value)).toEqual([
      "1",
      "2",
    ]);
    expect(first?.response.content).toEqual({
      size: 11,
      mimeType: "application/json",
      text: '{"ok":true}',
    });
  });

  it("round-trips binary bodies through base64", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const binary: BodyInput = { bytes, contentType: "application/octet-stream" };
    const [first] = har([
      entry({
        request: request({ method: "PUT", body: binary }),
        response: { status: 200, httpVersion: "HTTP/1.1", headers: [], body: binary },
      }),
    ]).log.entries;
    expect(first?.response.content.encoding).toBe("base64");
    expect(base64ToBytes(first?.response.content.text ?? "")).toEqual(bytes);
    expect(first?.request.postData?._encoding).toBe("base64");
    expect(base64ToBytes(first?.request.postData?.text ?? "")).toEqual(bytes);
  });

  it("uses decoded bytes for content and reports the compression", () => {
    const [first] = har([
      entry({
        response: {
          status: 200,
          httpVersion: "HTTP/1.1",
          headers: [],
          body: {
            bytes: new Uint8Array([31, 139, 8]),
            decoded: encode("hello"),
            contentType: "text/plain",
            contentEncoding: "gzip",
          },
        },
      }),
    ]).log.entries;
    expect(first?.response.content).toEqual({
      size: 5,
      mimeType: "text/plain",
      compression: 2,
      text: "hello",
    });
  });

  it("parses request cookies and set-cookie attributes", () => {
    const [harEntry] = har([withCredentials]).log.entries;
    expect(harEntry?.request.cookies).toEqual([{ name: "sid", value: "s3cret" }]);
    expect(harEntry?.response.cookies).toEqual([
      { name: "sid", value: "s3cret", path: "/", httpOnly: false, secure: false },
    ]);
  });
});

describe("exportRequests cURL", () => {
  it.each([
    {
      name: "a GET drops derived headers and keeps duplicates",
      input: entry(),
      expected:
        "curl 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  -H 'X-Dup: 1' \\\n  -H 'X-Dup: 2'",
    },
    {
      name: "a POST body with ' and a newline uses $'…'",
      input: entry({
        request: request({ method: "POST", headers: [], body: { bytes: encode("it's\nok") } }),
      }),
      expected:
        "curl 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  --data-raw $'it\\'s\\nok'",
    },
    {
      name: "a body starting with @ is sent as-is, not read from a file",
      input: entry({
        request: request({ method: "POST", headers: [], body: { bytes: encode("@/etc/passwd") } }),
      }),
      expected:
        "curl 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  --data-raw '@/etc/passwd'",
    },
    {
      name: "a quote in a header is closed and escaped",
      input: entry({ request: request({ method: "DELETE", headers: [["X-Q", "a'b"]] }) }),
      expected:
        "curl -X 'DELETE' 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  -H 'X-Q: a'\\''b'",
    },
    {
      name: "binary without NUL is hex-escaped",
      input: entry({
        request: request({
          method: "PUT",
          headers: [],
          body: { bytes: new Uint8Array([0xff, 0x41, 0x27]) },
        }),
      }),
      expected:
        "curl -X 'PUT' 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  --data-raw $'\\xffA\\''",
    },
    {
      name: "binary with NUL is piped from printf",
      input: entry({
        request: request({
          method: "POST",
          headers: [],
          body: { bytes: new Uint8Array([0, 0x25, 0x5c, 0x27, 0x41]) },
        }),
      }),
      expected:
        "printf '\\000%%\\\\'\\''A' | curl 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  --data-binary @-",
    },
    {
      name: "a truncated body gets a warning line",
      input: entry({
        request: request({
          method: "POST",
          headers: [],
          body: { bytes: encode("ab"), truncated: true },
        }),
      }),
      expected:
        "# The captured request body was truncated at 2 bytes.\ncurl 'https://api.example.com/v1/items?q=a%20b&flag' \\\n  --data-raw 'ab'",
    },
  ])("$name", ({ input, expected }) => {
    expect(exportRequests([input], { format: "curl", creator }).text).toBe(expected);
  });
});

describe("exportRequests snippets", () => {
  const post = entry({
    request: request({
      method: "POST",
      headers: [
        ["Content-Type", "application/json"],
        ["Content-Length", "7"],
        ["X-Dup", "1"],
        ["X-Dup", "2"],
      ],
      body: { bytes: encode('{"é":1}'), contentType: "application/json" },
    }),
  });

  it.each([
    {
      format: "fetch" as const,
      input: post,
      expected: [
        'await fetch("https://api.example.com/v1/items?q=a%20b&flag", {',
        '  method: "POST",',
        "  headers: [",
        '    ["Content-Type", "application/json"],',
        '    ["X-Dup", "1"],',
        '    ["X-Dup", "2"],',
        "  ],",
        '  body: "{\\"é\\":1}",',
        "});",
      ].join("\n"),
    },
    {
      format: "fetch" as const,
      input: entry({
        request: request({ method: "PUT", headers: [], body: { bytes: new Uint8Array([0, 1]) } }),
      }),
      expected: [
        'await fetch("https://api.example.com/v1/items?q=a%20b&flag", {',
        '  method: "PUT",',
        '  body: Uint8Array.from(atob("AAE="), (c) => c.charCodeAt(0)),',
        "});",
      ].join("\n"),
    },
    {
      format: "python" as const,
      input: post,
      expected: [
        "import requests",
        "",
        "response = requests.request(",
        '    "POST",',
        '    "https://api.example.com/v1/items?q=a%20b&flag",',
        "    headers={",
        '        "Content-Type": "application/json",',
        '        "X-Dup": "1, 2",',
        "    },",
        '    data="{\\"é\\":1}".encode(),',
        ")",
      ].join("\n"),
    },
    {
      format: "python" as const,
      input: entry({
        request: request({ method: "PUT", headers: [], body: { bytes: new Uint8Array([0, 1]) } }),
      }),
      expected: [
        "import base64",
        "",
        "import requests",
        "",
        "response = requests.request(",
        '    "PUT",',
        '    "https://api.example.com/v1/items?q=a%20b&flag",',
        '    data=base64.b64decode("AAE="),',
        ")",
      ].join("\n"),
    },
  ])("$format", ({ format, input, expected }) => {
    expect(exportRequests([input], { format, creator }).text).toBe(expected);
  });
});

describe("exportRequests raw and JSON", () => {
  it("raw keeps duplicates and joins request and response", () => {
    expect(exportRequests([entry()], { format: "raw", creator }).text).toBe(
      [
        "GET /v1/items?q=a%20b&flag HTTP/1.1",
        "Host: api.example.com",
        "X-Dup: 1",
        "X-Dup: 2",
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Set-Cookie: a=1",
        "Set-Cookie: b=2",
        "",
        '{"ok":true}',
      ].join("\n"),
    );
  });

  it("JSON keeps tunnels with their byte counts", () => {
    const parsed = JSON.parse(exportRequests([tunnel], { format: "json", creator }).text) as {
      requests: unknown[];
    };
    expect(parsed.requests).toEqual([
      {
        id: "8",
        flowType: "tunnel",
        startedAt: 0,
        endedAt: 50,
        method: "CONNECT",
        url: "https://api.example.com/",
        httpVersion: "HTTP/1.1",
        sni: "api.example.com",
        clientAddr: "127.0.0.1:5000",
        bytesUp: 10,
        bytesDown: 20,
        request: { headers: [], body: null },
        response: null,
        error: null,
      },
    ]);
  });

  it("includeBodies: false leaves body text out but keeps sizes", () => {
    const parsed = JSON.parse(
      exportRequests([entry()], { format: "json", creator, includeBodies: false }).text,
    ) as { requests: Array<{ response: { body: unknown } }> };
    expect(parsed.requests[0]?.response.body).toEqual({
      bytes: 11,
      truncated: false,
      contentType: "application/json",
      decoded: false,
    });
  });
});

describe("exportRequests across formats", () => {
  const formats: ExportFormat[] = ["har", "curl", "raw", "json", "fetch", "python"];

  it.each(formats)("%s keeps cookie and auth values as captured", (format) => {
    const text = exportRequests([withCredentials], { format, creator }).text;
    expect(text).toContain("s3cret");
    expect(text).toContain("t0ken");
    expect(text).toContain("cHJveHk=");
  });

  it.each(formats)("%s counts tunnels only in JSON", (format) => {
    const result = exportRequests([entry(), tunnel], { format, creator });
    expect(result.count).toBe(format === "json" ? 2 : 1);
    expect(result.text.includes("127.0.0.1:5000")).toBe(format === "json");
  });
});
