// @effect-diagnostics nodeBuiltinImport:off - Builds compressed fixtures for the builtin-only decoder.
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { decodeChain, type DecodeStep, type DecodeStepResult, parseDecodeSteps } from "./decode.ts";

const text = (value: string) => new TextEncoder().encode(value);
const MiB = 1024 * 1024;

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
// printf '{"id":12345678901234567890,"tags":[],"n":{"a":[1,"x\"y"]}}' | gzip -n | base64
const GZIP_JSON_BASE64 =
  "H4sIAAAAAAAAA6tWykxRsjI0MjYxNTO3sDRAsHSUShLTi5WsomN1lPKUrKqVEoFsQx2lihilSqXY2loA3fEg3DoAAAA=";
// printf 'hello aes-cbc' | openssl enc -aes-128-cbc -K 000102…0f -iv 0f0e…00 | base64
const CBC = {
  mode: "cbc",
  key: "000102030405060708090a0b0c0d0e0f",
  iv: "0f0e0d0c0b0a09080706050403020100",
  encoding: "hex",
} as const;
// NIST SP 800-38A F.5.1, first block.
const NIST_KEY = "2b7e151628aed2a6abf7158809cf4f3c";
// McGrew-Viega GCM test case 2: zero key and iv, one zero block.
const GCM = {
  mode: "gcm",
  key: "00000000000000000000000000000000",
  iv: "000000000000000000000000",
  tag: "ab6e47d42cec13bdf53a67b21257bddf",
  encoding: "hex",
} as const;

interface ChainCase {
  name: string;
  source: string | Uint8Array;
  steps: DecodeStep[];
  expected: Partial<DecodeStepResult>[];
}

const cases: ChainCase[] = [
  {
    name: "JWT header, payload, and raw signature",
    source: JWT,
    steps: [{ op: "jwt" }],
    expected: [
      {
        ok: true,
        isText: true,
        text: JSON.stringify(
          {
            header: { alg: "HS256", typ: "JWT" },
            payload: { sub: "1234567890", name: "John Doe", iat: 1516239022 },
            signature: "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: "base64 → gzip → json keeps big integers",
    source: GZIP_JSON_BASE64,
    steps: [{ op: "base64" }, { op: "gzip" }, { op: "json" }],
    expected: [
      { ok: true, isText: false },
      {
        ok: true,
        isText: true,
        text: '{"id":12345678901234567890,"tags":[],"n":{"a":[1,"x\\"y"]}}',
      },
      {
        ok: true,
        text: '{\n  "id": 12345678901234567890,\n  "tags": [],\n  "n": {\n    "a": [\n      1,\n      "x\\"y"\n    ]\n  }\n}',
      },
    ],
  },
  {
    name: "AES-128-CBC openssl vector",
    source: "p9r8XNxC/BxHLZuc4oKq9g==",
    steps: [{ op: "base64" }, { op: "aes", aes: CBC }],
    expected: [
      { ok: true, bytes: 16 },
      { ok: true, isText: true, text: "hello aes-cbc" },
    ],
  },
  {
    name: "AES-128-CTR NIST vector",
    source: "874d6191b620e3261bef6864990db6ce",
    steps: [
      { op: "hex" },
      {
        op: "aes",
        aes: {
          mode: "ctr",
          key: NIST_KEY,
          iv: "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
          encoding: "hex",
        },
      },
      { op: "hex", direction: "encode" },
    ],
    expected: [
      { ok: true },
      { ok: true, isText: false },
      { ok: true, text: "6bc1bee22e409f96e93d7e117393172a" },
    ],
  },
  {
    name: "AES-128-GCM vector",
    source: "0388dace60b6a392f328c2b971b2fe78",
    steps: [{ op: "hex" }, { op: "aes", aes: GCM }],
    expected: [
      { ok: true },
      { ok: true, bytes: 16, isText: false, base64: "AAAAAAAAAAAAAAAAAAAAAA==" },
    ],
  },
  {
    name: "AES-GCM with a wrong tag fails that step and keeps earlier ones",
    source: "0388dace60b6a392f328c2b971b2fe78",
    steps: [
      { op: "hex" },
      { op: "aes", aes: { ...GCM, tag: "00".repeat(16) } },
      { op: "hex", direction: "encode" },
    ],
    expected: [
      { ok: true, bytes: 16 },
      { ok: false, error: "AES-GCM authentication failed (wrong key, iv, or tag)" },
    ],
  },
  {
    name: "AES-CBC with a wrong key reports a padding error",
    source: "p9r8XNxC/BxHLZuc4oKq9g==",
    steps: [{ op: "base64" }, { op: "aes", aes: { ...CBC, key: "ff".repeat(16) } }],
    expected: [{ ok: true }, { ok: false }],
  },
  {
    name: "AES key length must be 16, 24, or 32 bytes",
    source: "00",
    steps: [{ op: "aes", aes: { ...CBC, key: "0011" } }],
    expected: [{ ok: false, error: "AES key must be 16, 24, or 32 bytes (got 2)" }],
  },
  {
    name: "XOR with a repeating key round-trips",
    source: "hello",
    steps: [
      { op: "xor", xor: { key: "k", encoding: "utf8" } },
      { op: "xor", xor: { key: "6b", encoding: "hex" } },
    ],
    expected: [
      { ok: true, isText: false, base64: "Aw4HBwQ=" },
      { ok: true, text: "hello" },
    ],
  },
  {
    name: "url decodes bytes and form spaces, and encodes back",
    source: "a%20b+c%2B%E2%82%AC%zz",
    steps: [{ op: "url" }, { op: "url", direction: "encode" }],
    expected: [
      { ok: true, text: "a b c+€%zz" },
      { ok: true, text: "a%20b%20c%2B%E2%82%AC%25zz" },
    ],
  },
  {
    name: "html entities round-trip",
    source: `<a href="x">Tom & 'Jerry'</a>`,
    steps: [{ op: "html", direction: "encode" }, { op: "html" }],
    expected: [
      { ok: true, text: "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;" },
      { ok: true, text: `<a href="x">Tom & 'Jerry'</a>` },
    ],
  },
  {
    name: "html decodes numeric and named entities and leaves unknown ones",
    source: "&#x1F600;&#169;&euro;&bogus;",
    steps: [{ op: "html" }],
    expected: [{ ok: true, text: "😀©€&bogus;" }],
  },
  {
    name: "unicode escapes decode surrogate pairs, braces, and raw bytes",
    source: "\\u00e9\\ud83d\\ude00\\u{1F680}\\xe2\\x82\\xac\\x41",
    steps: [{ op: "unicode" }, { op: "unicode", direction: "encode" }, { op: "unicode" }],
    expected: [
      { ok: true, text: "é😀🚀€A" },
      { ok: true, text: "\\u00e9\\ud83d\\ude00\\ud83d\\ude80\\u20acA" },
      { ok: true, text: "é😀🚀€A" },
    ],
  },
  {
    name: "base64url, hex, deflate, and brotli round-trip",
    source: "?>~ binary-ish ÿ",
    steps: [
      { op: "deflate", direction: "encode" },
      { op: "deflate" },
      { op: "brotli", direction: "encode" },
      { op: "brotli" },
      { op: "base64url", direction: "encode" },
      { op: "base64url" },
      { op: "hex", direction: "encode" },
      { op: "hex" },
    ],
    expected: [
      { ok: true },
      { ok: true, text: "?>~ binary-ish ÿ" },
      { ok: true },
      { ok: true, text: "?>~ binary-ish ÿ" },
      { ok: true, text: "Pz5-IGJpbmFyeS1pc2ggw78" },
      { ok: true, text: "?>~ binary-ish ÿ" },
      { ok: true },
      { ok: true, text: "?>~ binary-ish ÿ" },
    ],
  },
  {
    name: "deflate falls back to raw deflate",
    source: NodeZlib.deflateRawSync(text("raw stream")),
    steps: [{ op: "deflate" }],
    expected: [{ ok: true, text: "raw stream" }],
  },
  {
    name: "hash produces hex text",
    source: "abc",
    steps: [
      { op: "hash", algorithm: "sha256" },
      { op: "hash", algorithm: "md5" },
    ],
    expected: [
      { ok: true, text: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      { ok: true, bytes: 32 },
    ],
  },
  {
    name: "gzip bomb stops at the per-step output cap",
    source: NodeZlib.gzipSync(new Uint8Array(8 * MiB)),
    steps: [{ op: "gzip" }, { op: "json" }],
    expected: [{ ok: false, error: "output exceeds 4 MiB" }],
  },
  {
    name: "brotli bomb stops at the per-step output cap",
    source: NodeZlib.brotliCompressSync(new Uint8Array(8 * MiB)),
    steps: [{ op: "brotli" }],
    expected: [{ ok: false, error: "output exceeds 4 MiB" }],
  },
  {
    name: "invalid base64 is that step's error",
    source: "not base64!",
    steps: [{ op: "base64" }],
    expected: [{ ok: false, error: "input is not valid base64" }],
  },
  {
    name: "encode on a decode-only op is that step's error",
    source: "{}",
    steps: [{ op: "json" }, { op: "jwt", direction: "encode" }],
    expected: [
      { ok: true, text: "{}" },
      { ok: false, error: "jwt has no encode direction" },
    ],
  },
];

describe("decodeChain", () => {
  it.each(cases)("$name", ({ source, steps, expected }) => {
    const result = decodeChain(typeof source === "string" ? text(source) : source, steps);
    expect(result.error).toBeUndefined();
    expect(result.steps).toHaveLength(expected.length);
    expected.forEach((step, index) => expect(result.steps[index]).toMatchObject(step));
  });

  it("caps previews and flags truncation", () => {
    const result = decodeChain(text("a".repeat(70_000)), [
      { op: "unicode" },
      { op: "xor", xor: { key: "ff", encoding: "hex" } },
    ]);
    expect(result.steps[0]).toMatchObject({ bytes: 70_000, isText: true, truncated: true });
    expect(result.steps[0]?.text).toHaveLength(64 * 1024);
    expect(result.steps[1]).toMatchObject({ bytes: 70_000, isText: false, truncated: true });
    expect(result.steps[1]?.base64).toHaveLength(64 * 1024);
  });

  it("refuses input over 1 MiB", () => {
    expect(decodeChain(new Uint8Array(MiB + 1), [{ op: "hex" }])).toEqual({
      steps: [],
      error: "input exceeds 1 MiB",
    });
  });
});

describe("parseDecodeSteps", () => {
  it.each([
    { raw: "nope", reason: "steps must be an array" },
    {
      raw: Array.from({ length: 17 }, () => ({ op: "hex" })),
      reason: "steps must have at most 16 entries",
    },
    { raw: [{ op: "rot13" }], reason: /^steps\[0\]\.op must be one of/ },
    {
      raw: [{ op: "hex" }, { op: "jwt", direction: "encode" }],
      reason: "steps[1]: jwt has no encode direction",
    },
    { raw: [{ op: "hash" }], reason: /^steps\[0\]\.algorithm/ },
    {
      raw: [{ op: "aes", aes: { ...GCM, tag: undefined } }],
      reason: "steps[0].aes.tag is required for gcm",
    },
    {
      raw: [{ op: "aes", aes: { ...CBC, encoding: "latin1" } }],
      reason: /^steps\[0\]\.aes\.encoding/,
    },
    {
      raw: [{ op: "xor", xor: { key: "", encoding: "utf8" } }],
      reason: "steps[0].xor.key must be a non-empty string",
    },
  ])("rejects $raw", ({ raw, reason }) => {
    const result = parseDecodeSteps(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("keeps only known fields of valid steps", () => {
    expect(
      parseDecodeSteps([
        { op: "base64", direction: "encode", extra: 1 },
        { op: "hash", algorithm: "sha1", aes: CBC },
        { op: "aes", aes: { ...GCM, extra: true } },
      ]),
    ).toEqual({
      ok: true,
      steps: [
        { op: "base64", direction: "encode" },
        { op: "hash", algorithm: "sha1" },
        { op: "aes", aes: GCM },
      ],
    });
  });
});
