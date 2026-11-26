// @effect-diagnostics nodeBuiltinImport:off -- Exercise atomic saves against real temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { DesktopRelayTransport } from "./DesktopRelayTransport.ts";
import { saveDesktopRelayMedia } from "./DesktopRelaySave.ts";

const origin = "https://relay.example";
const binding = {
  origin,
  hostname: "relay.example",
  environmentId: "env",
  transportRole: "relay",
  spkiSha256: "pin",
} as const;
const url = origin + "/api/assets/fixture.signature/report.bin?order=2&q=a%2fb+%20&order=1";
const original = new Uint8Array([0, 255, 8, 7]);
const originalETag = `"sha256-${NodeCrypto.createHash("sha256").update(original).digest("hex")}-${"0".repeat(64)}"`;
const options = (status: number, length: string) => ({
  status,
  statusText: "",
  headers: [
    ["content-length", length],
    ["content-type", "application/octet-stream"],
    ["etag", originalETag],
  ] as const,
  body: new Response(original).body,
});
const transportFor = (request: DesktopRelayTransport["request"]): DesktopRelayTransport => ({
  origins: [origin],
  getBinding: (candidate) => (candidate === origin ? binding : undefined),
  request,
  openSocket: () => Promise.reject(new Error("Unused fixture operation.")),
});

it("validates before opening the dialog and makes no request when the user cancels", async () => {
  const request = vi.fn<DesktopRelayTransport["request"]>();
  const pick = vi.fn(async () => undefined);
  const signal = new AbortController().signal;
  for (const input of [
    url + "#t=1",
    url.replace(origin, "https://foreign.example"),
    origin + "/api/auth/session",
  ]) {
    await expect(
      saveDesktopRelayMedia(transportFor(request), signal, input, "report.bin", pick),
    ).rejects.toThrow();
  }
  expect(pick).not.toHaveBeenCalled();
  await expect(
    saveDesktopRelayMedia(transportFor(request), signal, url, "../report.bin", pick),
  ).resolves.toBeUndefined();
  expect(pick).toHaveBeenCalledOnce();
  expect(pick).toHaveBeenCalledWith(".._report.bin");
  expect(request).not.toHaveBeenCalled();
});

it("commits complete original bytes and preserves an existing file on inconsistent responses", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "desktop-relay-save-"));
  const destination = NodePath.join(directory, "saved.dat");
  const signal = new AbortController().signal;
  try {
    const request = vi.fn<DesktopRelayTransport["request"]>();
    const save = () =>
      saveDesktopRelayMedia(
        transportFor(request),
        signal,
        url,
        "report.bin",
        async () => destination,
      );
    await NodeFSP.writeFile(destination, "existing");
    for (const response of [
      options(206, "4"),
      options(200, "3"),
      options(200, "5"),
      options(200, "17179869185"),
    ]) {
      request.mockResolvedValueOnce(response);
      await expect(save()).rejects.toThrow();
      expect(await NodeFSP.readFile(destination, "utf8")).toBe("existing");
      expect(await NodeFSP.readdir(directory)).toEqual(["saved.dat"]);
    }
    request.mockResolvedValueOnce(options(200, "4"));
    await expect(save()).resolves.toBeUndefined();
    expect(await NodeFSP.readFile(destination)).toEqual(Buffer.from(original));
    expect(await NodeFSP.readdir(directory)).toEqual(["saved.dat"]);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "GET",
        target: url.slice(origin.length),
        headers: { range: "bytes=0-8388607", "x-t3-media-download": "sha-256" },
      }),
      expect.any(AbortSignal),
      undefined,
      undefined,
      8 * 1024 ** 2,
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("aborts a save when its owning document is disposed", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "desktop-relay-save-"));
  const destination = NodePath.join(directory, "saved.dat");
  const owner = new AbortController();
  const { promise: started, resolve: begin } = Promise.withResolvers<void>();
  const request: DesktopRelayTransport["request"] = async () => ({
    ...options(200, "4"),
    body: new ReadableStream(
      {
        start(controller) {
          controller.enqueue(original.subarray(0, 2));
        },
        pull() {
          begin();
        },
      },
      { highWaterMark: 0 },
    ),
  });
  try {
    const saving = saveDesktopRelayMedia(
      transportFor(request),
      owner.signal,
      url,
      "report.bin",
      async () => destination,
    );
    await started;
    owner.abort();
    await expect(saving).rejects.toThrow();
    expect(await NodeFSP.readdir(directory)).toEqual([]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("assembles consecutive conditional ranges and preserves the exact signed request target", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "desktop-relay-range-"));
  const destination = NodePath.join(directory, "saved.dat");
  const firstSize = 8 * 1024 ** 2;
  const first = new Uint8Array(firstSize).fill(42);
  const request = vi.fn<DesktopRelayTransport["request"]>();
  const sha256 = NodeCrypto.createHash("sha256").update(first).update(original).digest("hex");
  const etag = `"sha256-${sha256}-${"0".repeat(64)}"`;
  const range = (
    bytes: Uint8Array<ArrayBuffer>,
    start: number,
    overrides: Record<string, string> = {},
  ) => ({
    status: 206,
    statusText: "",
    headers: Object.entries({
      "content-length": String(bytes.length),
      "content-range": `bytes ${start}-${start + bytes.length - 1}/${firstSize + original.length}`,
      "content-type": "application/octet-stream",
      etag,
      ...overrides,
    }),
    body: new Response(bytes).body,
  });
  const save = () =>
    saveDesktopRelayMedia(
      transportFor(request),
      new AbortController().signal,
      url,
      "report.bin",
      async () => destination,
    );
  try {
    const next = `bytes ${firstSize}-${firstSize + 3}`;
    await NodeFSP.writeFile(destination, "existing");
    const changes = [
      range(original, firstSize, { etag: '"other"' }),
      range(original, firstSize, { etag: 'W/"same"' }),
      range(original, firstSize - 1),
      range(original, firstSize, { "content-range": `${next}/${firstSize + 5}` }),
      range(original, firstSize, { "content-type": "video/mp4" }),
      range(original, firstSize, { "content-length": "3" }),
      range(original.subarray(0, 3), firstSize, {
        "content-length": "4",
        "content-range": `${next}/${firstSize + 4}`,
      }),
      range(Uint8Array.of(1, 2, 3, 4), firstSize),
      options(200, "4"),
    ];
    for (const response of changes) {
      request.mockResolvedValueOnce(range(first, 0)).mockResolvedValueOnce(response);
      await expect(save()).rejects.toThrow();
      expect(await NodeFSP.readFile(destination, "utf8")).toBe("existing");
      expect(await NodeFSP.readdir(directory)).toEqual(["saved.dat"]);
    }
    request
      .mockResolvedValueOnce(range(first, 0))
      .mockResolvedValueOnce(range(original, firstSize));
    await save();
    const bytes = await NodeFSP.readFile(destination);
    expect(bytes.subarray(0, firstSize).equals(first)).toBe(true);
    expect(bytes.subarray(firstSize)).toEqual(Buffer.from(original));
    expect(request.mock.calls.map(([input]) => [input.target, input.headers])).toEqual(
      Array.from({ length: changes.length + 1 }, () => [
        [url.slice(origin.length), { range: "bytes=0-8388607", "x-t3-media-download": "sha-256" }],
        [
          url.slice(origin.length),
          { range: "bytes=8388608-8388611", "if-range": etag, "x-t3-media-download": "sha-256" },
        ],
      ]).flat(),
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
