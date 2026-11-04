import { describe, expect, it, vi } from "vite-plus/test";

import type { PluginSaveData } from "./ui.ts";

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A fake host window that answers the bridge; `failAppend` refuses the nth append. */
async function connectToFakeHost(options: { readonly failAppend?: number } = {}) {
  const sent: Array<Sent> = [];
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  let appends = 0;
  const host = {
    postMessage: (message: { id: number; method: string; params: Record<string, unknown> }) => {
      sent.push({ method: message.method, params: message.params });
      let reply: Record<string, unknown>;
      if (message.method === "t3/initialize") {
        reply = { result: { apiVersion: "1.1", hostContext: { apiVersion: "1.1" } } };
      } else if (message.method === "t3/file.save.begin") {
        reply = { result: { saveId: "save-0" } };
      } else if (message.method === "t3/file.save.append" && ++appends === options.failAppend) {
        reply = { error: { code: -32000, message: "Disk full." } };
      } else if (message.method === "t3/file.save.commit") {
        reply = { result: { outcome: "saved" } };
      } else {
        reply = { result: {} };
      }
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ source: host, data: { jsonrpc: "2.0", id: message.id, ...reply } });
        }
      });
    },
  };
  vi.stubGlobal("window", {
    parent: host,
    addEventListener: (_type: string, listener: (typeof listeners)[number]) => {
      listeners.push(listener);
    },
  });
  vi.resetModules();
  const { connectT3 } = await import("./ui.ts");
  const client = await connectT3();
  vi.unstubAllGlobals();
  return { client, sent };
}

const bytesOf = (sent: ReadonlyArray<Sent>) =>
  sent
    .filter((message) => message.method === "t3/file.save.append")
    .map((message) => Uint8Array.from(atob(String(message.params.base64)), (c) => c.charCodeAt(0)));

const large = Uint8Array.from({ length: 250 * 1024 }, (_, index) => index % 251);

describe("saveFile", () => {
  it.each<{
    readonly name: string;
    readonly data: () => PluginSaveData;
    readonly failAppend?: number;
    readonly begin: Record<string, unknown>;
    readonly appendSizes: ReadonlyArray<number>;
    readonly last: string;
  }>([
    {
      name: "re-chunks large bytes into appends of at most 96 KiB",
      data: () => large,
      begin: { name: "a.bin", mimeType: "application/octet-stream", size: large.length },
      appendSizes: [96 * 1024, 96 * 1024, 58 * 1024],
      last: "t3/file.save.commit",
    },
    {
      name: "begins an unsized stream before reading it",
      data: () =>
        async function* () {
          yield large.subarray(0, 100 * 1024);
          yield large.subarray(100 * 1024);
        },
      begin: { name: "a.bin", mimeType: "application/octet-stream" },
      appendSizes: [96 * 1024, 4 * 1024, 96 * 1024, 54 * 1024],
      last: "t3/file.save.commit",
    },
    {
      name: "aborts when an append fails",
      data: () => large,
      failAppend: 2,
      begin: { name: "a.bin", mimeType: "application/octet-stream", size: large.length },
      appendSizes: [96 * 1024, 96 * 1024],
      last: "t3/file.save.abort",
    },
  ])("$name", async ({ data, failAppend, begin, appendSizes, last }) => {
    const { client, sent } = await connectToFakeHost(
      failAppend === undefined ? {} : { failAppend },
    );
    const saving = client.saveFile("a.bin", "application/octet-stream", data());
    // Posted synchronously, so the host sees it while the click is fresh.
    expect(sent.at(-1)).toEqual({ method: "t3/file.save.begin", params: begin });
    if (failAppend === undefined) {
      await expect(saving).resolves.toBe("saved");
    } else {
      await expect(saving).rejects.toThrow("Disk full.");
    }
    expect(sent.at(-1)?.method).toBe(last);
    const appended = bytesOf(sent);
    expect(appended.map((chunk) => chunk.length)).toEqual(appendSizes);
    if (failAppend === undefined) {
      expect(new Uint8Array(appended.flatMap((chunk) => [...chunk]))).toEqual(large);
    } else {
      expect(sent.at(-1)?.params).toEqual({ saveId: "save-0" });
    }
  });

  it("exposes the host's apiVersion as hostApi", async () => {
    const { client, sent } = await connectToFakeHost();
    expect(sent[0]).toEqual({ method: "t3/initialize", params: { apiVersion: "1.0" } });
    expect(client.hostApi).toBe("1.1");
  });
});
