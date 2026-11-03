// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only inspector body helpers on real node:sqlite.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import { PLUGIN_LIMITS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BODY_LIMITS, makeBodyReader, makeDraftStore } from "./bodies.ts";
import { requestDetail } from "./inspector.ts";
import { DRAFT_MISSING_DETAIL } from "./refusals.ts";
import { makeReplayService } from "./replay.ts";
import { makeFakeCarriers } from "./replay.testkit.ts";
import { type InspectorStore, InspectorRefusal, type RequestRecord } from "./store.ts";
import {
  header,
  KiB,
  makeFlow,
  MiB,
  openTempStore,
  patternBytes,
  startCapture,
} from "./store.testkit.ts";

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const insertBody = async (store: InspectorStore, bytes: Buffer, encoding?: string) => {
  const capture = await startCapture(store);
  const result = await store.insertFlow(
    makeFlow(capture.id, 0, 0, {
      response: {
        status: 200,
        httpVersion: "HTTP/1.1",
        headers: [
          header("content-length", String(bytes.byteLength)),
          ...(encoding === undefined ? [] : [header("content-encoding", encoding)]),
        ],
        body: { bytes },
      },
    }),
  );
  if (!result.ok) throw new Error("insert failed");
  return { requestId: result.id, captureId: capture.id };
};

describe("read_body", () => {
  it("read_body pages a 1 MiB binary body in 128 KiB chunks that reassemble byte-exact, and refuses length > 131072", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB, maxBodyBytes: 1 * MiB });
    const { store } = temp;
    const body = patternBytes(1 * MiB, 7);
    const { requestId } = await insertBody(store, body);
    const read = makeBodyReader(store);

    const chunks: Array<Buffer> = [];
    for (let offset = 0, eof = false; !eof;) {
      const page = read({ requestId, side: "response", offset, length: BODY_LIMITS.maxChunkBytes });
      expect(page).toMatchObject({
        offset,
        totalBytes: body.byteLength,
        truncatedAtCapture: false,
      });
      chunks.push(Buffer.from(page.base64, "base64"));
      offset += page.length;
      eof = page.eof;
    }
    expect(chunks).toHaveLength(8);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    expect(() =>
      read({ requestId, side: "response", offset: 0, length: BODY_LIMITS.maxChunkBytes + 1 }),
    ).toThrow(InspectorRefusal);
    expect(() =>
      read({ requestId: requestId + 1, side: "response", offset: 0, length: 1 }),
    ).toThrow("This request no longer exists.");
  });

  it("read_body decoded:true returns gunzipped bytes; decoded:false returns raw wire bytes", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const text = Buffer.from("hello inspector ".repeat(4096));
    const gzip = NodeZlib.gzipSync(text);
    const { requestId } = await insertBody(store, gzip, "gzip");
    const read = makeBodyReader(store);

    const raw = read({ requestId, side: "response", offset: 0, length: BODY_LIMITS.maxChunkBytes });
    expect(Buffer.from(raw.base64, "base64").equals(gzip)).toBe(true);
    expect(raw).toMatchObject({ totalBytes: gzip.byteLength, eof: true });

    const decoded = read({
      requestId,
      side: "response",
      offset: 0,
      length: BODY_LIMITS.maxChunkBytes,
      decoded: true,
    });
    expect(Buffer.from(decoded.base64, "base64").equals(text)).toBe(true);
    expect(decoded).toMatchObject({ totalBytes: text.byteLength, eof: true });

    const brotli = await store.insertFlow(
      makeFlow(store.captureStatus().running?.id ?? 0, 1, 0, {
        response: {
          status: 200,
          httpVersion: "HTTP/1.1",
          headers: [header("content-encoding", "br")],
          body: { bytes: NodeZlib.brotliCompressSync(text) },
        },
      }),
    );
    if (!brotli.ok) throw new Error("insert failed");
    const decodedBrotli = read({
      requestId: brotli.id,
      side: "response",
      offset: 0,
      length: 16,
      decoded: true,
    });
    expect(Buffer.from(decodedBrotli.base64, "base64").toString()).toBe("hello inspector ");
  });

  it("every operation result for the 1 MiB fixture and a control-byte text fixture stays under PLUGIN_LIMITS.maxPayloadBytes", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 256 * MiB, maxBodyBytes: 1 * MiB });
    const { store } = temp;
    const body = patternBytes(1 * MiB, 3);
    const { requestId, captureId } = await insertBody(store, body);
    for (let index = 0; index < 250; index += 1) {
      await store.insertFlow(makeFlow(captureId, index, 0, { path: `/${"p".repeat(4000)}` }));
    }
    const control = "\x01".repeat(32 * KiB);
    const textSide = [header("content-type", "text/plain")];
    const escaped = await store.insertFlow(
      makeFlow(captureId, 251, 0, {
        path: `/${control}`,
        headers: [
          ...textSide,
          ...[1, 2, 3, 4].map((n) => header(`x-${n}`, control.slice(0, 8 * KiB))),
        ],
        body: { bytes: Buffer.from(control, "latin1") },
        response: {
          status: 200,
          httpVersion: "HTTP/1.1",
          headers: textSide,
          body: { bytes: Buffer.from(control, "latin1") },
        },
      }),
    );
    if (!escaped.ok) throw new Error("insert failed");
    const read = makeBodyReader(store);
    const drafts = makeDraftStore(store);
    const replayPreview = makeReplayService({
      store,
      drafts,
      carriers: makeFakeCarriers().carriers,
    }).preview({ requestId: escaped.id });
    expect(replayPreview).toMatchObject({ path: `/${control}`.slice(0, 512), pathTruncated: true });

    const results: Array<unknown> = [
      requestDetail(store, store.getRequest(escaped.id) as RequestRecord, {
        previewBytes: 32768,
        bodies: "both",
        includeSensitiveHeaders: true,
      }),
      read({ requestId, side: "response", offset: 0, length: BODY_LIMITS.maxChunkBytes }),
      read({
        requestId,
        side: "response",
        offset: 0,
        length: BODY_LIMITS.maxChunkBytes,
        decoded: true,
      }),
      store.search({}, { limit: 200 }),
      requestDetail(store, store.getRequest(requestId) as RequestRecord, {
        previewBytes: 32768,
        bodies: "both",
        includeSensitiveHeaders: true,
      }),
      await drafts.write({
        offset: 0,
        base64: body.subarray(0, BODY_LIMITS.maxChunkBytes).toString("base64"),
      }),
    ];
    for (const result of results) {
      expect(jsonBytes(result)).toBeLessThanOrEqual(PLUGIN_LIMITS.maxPayloadBytes);
    }
  });
});

describe("body drafts", () => {
  it("body_draft_write assembles chunks and refuses a draft over 16 MiB", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const drafts = makeDraftStore(store);
    const chunk = BODY_LIMITS.maxChunkBytes;
    const body = patternBytes(BODY_LIMITS.maxDraftBytes, 11);

    let draftId: string | undefined;
    for (let offset = 0; offset < body.byteLength; offset += chunk) {
      const written = await drafts.write({
        ...(draftId === undefined ? {} : { draftId }),
        offset,
        base64: body.subarray(offset, offset + chunk).toString("base64"),
      });
      draftId = written.draftId;
      expect(written.size).toBe(offset + chunk);
    }
    if (draftId === undefined) throw new Error("no draft");
    expect(NodeFS.readFileSync(drafts.path(draftId) as string).equals(body)).toBe(true);

    await expect(
      drafts.write({
        draftId,
        offset: body.byteLength,
        base64: Buffer.from("x").toString("base64"),
      }),
    ).rejects.toThrow("A body draft is at most 16 MiB.");
    await expect(
      drafts.write({ draftId, offset: 0, base64: patternBytes(chunk + 1).toString("base64") }),
    ).rejects.toThrow(InspectorRefusal);
    expect(drafts.size(draftId)).toBe(body.byteLength);
  });

  // A replay naming the evicted draft is refused as not sent by replay.ts, through drafts.path.
  it("body_draft_write keeps at most 4 drafts, evicting the least recently written", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const drafts = makeDraftStore(store);
    const chunk = (seed: number) => patternBytes(KiB, seed).toString("base64");

    const ids: Array<string> = [];
    for (let seed = 0; seed < 4; seed += 1) {
      ids.push((await drafts.write({ offset: 0, base64: chunk(seed) })).draftId);
    }
    const [first, second] = ids as [string, string];
    await drafts.write({ draftId: first, offset: KiB, base64: chunk(9) });
    const fifth = (await drafts.write({ offset: 0, base64: chunk(5) })).draftId;

    expect(drafts.path(second)).toBeUndefined();
    expect(NodeFS.readdirSync(store.draftsDir).toSorted()).toEqual(
      [first, ids[2], ids[3], fifth].map((id) => `${id}.bin`).toSorted(),
    );
    expect(drafts.size(first)).toBe(2 * KiB);
    await expect(drafts.write({ draftId: second, offset: 0, base64: chunk(1) })).rejects.toThrow(
      DRAFT_MISSING_DETAIL,
    );
  });
});
